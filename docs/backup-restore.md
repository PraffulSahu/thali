# Backup and restore

What to back up, how, how often, and how to restore. The `mongodump` and `mongorestore` command forms below
were checked against the local compose stack (dump of a service database to an archive; restore with
`--dryRun`). A full restore drill has **not** been performed: it is on the launch checklist as a blocker.

## 1. What holds state

| Store | Holds | Loss impact | Backup |
|---|---|---|---|
| MongoDB `thali_identity` | users, sessions, admin credentials (argon2id hash, encrypted TOTP secret), audit log, signing keys (demo only) | Accounts and audit trail | Atlas continuous backup + logical dumps |
| MongoDB `thali_marketplace` | restaurants, menus, stock, coupons, memberships, ratings | Catalogue | same |
| MongoDB `thali_orders` | carts, checkouts, child orders, timelines, support tickets | Order history | same |
| MongoDB `thali_payments` | payment intents/events, refunds, **ledger**, payouts | **Financial record (retain 8 years, confirm with counsel)** | same, highest priority |
| MongoDB `thali_delivery` | partners, jobs, offers, location pings | Delivery history | same |
| MongoDB `thali_notifications` | notification log, provider callbacks | Audit of messages | same, lowest priority |
| Redis | streams, locks, rate limits, revocation keys, tickets | Rebuildable from the outbox (runbook section 8) | Optional (AOF) |
| S3 public bucket | images | Re-uploadable | Versioning |
| S3 private bucket | KYC documents | **Hard to recreate** | Versioning + cross-region replication |
| Secrets | `FIELD_ENCRYPTION_KEY` (per service), `JWT_PRIVATE_KEY_PEM`, others | Encrypted fields become unreadable | **Offline copy in a vault, separate from the database backups** |

Every service owns exactly one database, so a service can be backed up and restored independently. Cross-service
consistency is only guaranteed at the same point in time (section 5).

## 2. Production (Atlas): the primary mechanism

1. Enable **Continuous Cloud Backup with point-in-time recovery** on the cluster; choose a restore window of at
   least 7 days (matches the outbox retention) and snapshot retention per your finance policy.
2. Test restore into a separate staging cluster before launch and quarterly afterwards (section 6).
3. Keep Atlas audit/alert on backup failures.
4. Logical dumps (below) are a second, portable copy for each database; schedule nightly from a secondary node
   and ship them, encrypted, to a bucket in another account/region.

## 3. Logical backup with mongodump (per service database)

Local compose stack (root credentials come from the container environment; the archive is streamed to the
host so nothing is left inside the container):

```bash
mkdir -p backups/$(date +%F)
for db in identity marketplace orders payments delivery notifications; do
  docker compose exec -T mongo bash -c \
    'mongodump --uri="mongodb://$MONGO_INITDB_ROOT_USERNAME:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin" \
       --db=thali_'"$db"' --gzip --archive' > backups/$(date +%F)/thali_$db.archive.gz
done
ls -l backups/$(date +%F)
```

Atlas / any remote replica set (use a backup user, prefer a secondary):

```bash
mongodump --uri="mongodb+srv://thali_backup:<password>@<cluster>.mongodb.net/?readPreference=secondary" \
  --db=thali_payments --gzip --archive=thali_payments-$(date +%F).archive.gz
```

Notes

- Dump all six databases in the same run and keep them together (one backup set per timestamp).
- A per-database `mongodump` is consistent per collection but not a single snapshot across collections. Run it
  during low traffic, or rely on Atlas snapshots for a consistent point in time.
- Encrypt the archives at rest (they contain personal data, encrypted bank details and ledgers) and restrict
  access. Do not store them next to the `FIELD_ENCRYPTION_KEY` values.
- Frequency for the pilot: Atlas continuous; logical dumps at least daily for `thali_payments` and
  `thali_identity`, daily for the others; retain 30 daily and 12 monthly sets (adjust to policy).

## 4. Restore with mongorestore

Always rehearse into a scratch name first, compare, then restore for real. `--dryRun` validates the archive and
the namespace mapping without writing.

```bash
# Dry run: what would be restored, and under which database name
cat backups/2026-10-10/thali_orders.archive.gz | docker compose exec -T mongo bash -c \
  'mongorestore --uri="mongodb://$MONGO_INITDB_ROOT_USERNAME:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin" \
     --gzip --archive --dryRun --nsInclude="thali_orders.*"'

# Rehearsal: restore into a scratch database (does not touch the live one), then compare counts
cat backups/2026-10-10/thali_orders.archive.gz | docker compose exec -T mongo bash -c \
  'mongorestore --uri="mongodb://$MONGO_INITDB_ROOT_USERNAME:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin" \
     --gzip --archive --nsInclude="thali_orders.*" --nsFrom="thali_orders.*" --nsTo="thali_orders_restoretest.*"'

# Real restore of one service (drops the existing collections first)
cat backups/2026-10-10/thali_orders.archive.gz | docker compose exec -T mongo bash -c \
  'mongorestore --uri="mongodb://$MONGO_INITDB_ROOT_USERNAME:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin" \
     --gzip --archive --nsInclude="thali_orders.*" --drop'
```

(After a rehearsal, drop the scratch database: `db.getSiblingDB('thali_orders_restoretest').dropDatabase()`.)

Procedure for a real restore of one service:

1. Announce the maintenance window. Scale the service (and, if it emits events others depend on, think about
   its consumers) to zero so nothing writes during the restore. The other services keep running; they retry
   internal calls.
2. Restore with `--drop` as above. Indexes are restored from the archive; the service also recreates missing
   indexes on start.
3. Start the service; wait for `/health/ready`.
4. Reconcile (below).

On Atlas use the Restore UI/API (point in time or snapshot) to a new cluster or in place, or `mongorestore`
with a `mongodb+srv://` URI and the same flags.

## 5. After a restore: reconcile

A restore moves one database backwards while its peers and the payment provider moved forwards.

1. **Prefer restoring all six databases to the same instant** (Atlas PITR). Restoring only one service creates
   divergence: for example payments restored to before a refund that orders still shows as `SUCCEEDED`.
2. Run the reconcile steps in [07-runbook.md](07-runbook.md): intents that are not `CAPTURED` are reconciled
   against Razorpay; refunds created after the restore point must be compared with the provider's refund list
   and recorded by hand if missing; sweepers resume automatically.
3. If Redis was not restored to the same point, re-publish the outbox for the window (runbook section 8).
   Inbox deduplication (30 days) makes replays safe.
4. Replay dead letters; check the health page returns to zero lag and zero dead letters.
5. Notify affected users and support; tickets and notifications in the lost window do not exist anymore.

## 6. Restore drill (required before launch, then quarterly)

1. In staging, take a fresh snapshot/dump of all six databases.
2. Restore into a scratch cluster or scratch database names.
3. Compare document counts per collection and spot-check the ledger: `sum(amountPaise)` per account must equal
   the live balance endpoint (`GET /api/v1/admin/finance/balances?accountType=RESTAURANT`).
4. Boot one service against the restored database and exercise a read path.
5. Record elapsed time (restore time objective) and data-loss window (recovery point objective) in the launch
   checklist. Until this is done, the checklist item "backups drill" stays **pending**.

## 7. Redis persistence and backup (AOF)

Compose (and the infra stack) run `redis-server --appendonly yes --appendfsync everysec`: every write is
appended to the AOF and fsynced once per second, so a crash loses at most about one second of writes. The
default RDB snapshot rules (`save 3600 1 300 100 60 10000`) also apply, `maxmemory-policy` is `noeviction`
(required: eviction would silently drop stream entries and locks). Redis 7 stores the AOF as a directory
`/data/appendonlydir` (base RDB + incremental AOF + manifest) in the `redis-data` volume.

```bash
docker compose exec redis redis-cli config get appendonly        # appendonly yes
docker compose exec redis redis-cli info persistence | grep -E "aof_enabled|aof_last_write_status|rdb_last_save_time"
# On-demand compacted copy:
docker compose exec redis redis-cli bgrewriteaof
docker compose cp redis:/data/appendonlydir ./backups/$(date +%F)/redis-appendonlydir
```

Restore: stop Redis, replace the contents of the data directory's `appendonlydir` with the copy (keep the
`appendonly.aof.manifest`), start Redis, check `DBSIZE` and the stream lengths (`XLEN events.orders`).

Redis is **not** the system of record: the outbox in each service database is. If Redis data is lost or
suspect, do not try to repair it; start empty and re-publish the outbox (runbook section 8). In managed
services (ElastiCache has no AOF; MemoryDB/Redis Cloud/Upstash do) take the provider's snapshots, but plan
recovery around the outbox.

## 8. S3

Enable versioning on both buckets, a lifecycle rule that expires non-current versions after a retention period,
and cross-region replication for the private (KYC) bucket. Test object recovery from a previous version once.
