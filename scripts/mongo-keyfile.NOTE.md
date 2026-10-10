# Mongo replica-set keyfile

`docker-compose.infra.yml` runs a single-node replica set **without auth**, so it needs no keyfile (host port 27018 -> container 27017; the in-container rs member host stays `localhost:27017`).

The full stack (`docker-compose.yml`) enables auth and therefore needs a keyfile. It is generated automatically:
`infra/mongo/keyfile.sh` (the `mongo` container's entrypoint wrapper) writes a random keyfile into the
`mongo-keyfile` volume on first start and fixes its owner/permissions (`mongodb`, `0400`) on every start.
Nothing is committed and no manual step is needed. `docker compose down -v` discards it together with the data.

`scripts/mongo-keyfile` (the old manual location) stays git-ignored; it is no longer used.
