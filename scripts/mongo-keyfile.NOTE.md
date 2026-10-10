# Mongo replica-set keyfile

`docker-compose.infra.yml` runs a single-node replica set **without auth**, so it needs no keyfile.
The full stack (`docker-compose.yml`, added later) enables auth and therefore needs one:

```sh
openssl rand -base64 756 > scripts/mongo-keyfile
chmod 400 scripts/mongo-keyfile
```

`scripts/mongo-keyfile` is git-ignored. Never commit it.
