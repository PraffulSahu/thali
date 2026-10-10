#!/bin/bash
# Mongo entrypoint wrapper (docker-compose.yml `mongo` service).
#
# A replica set with auth enabled needs a shared keyfile (internal member auth), even with one member.
# The keyfile lives in the `mongo-keyfile` volume and is generated on first start, so no secret is ever
# committed or baked into an image. mongod refuses keyfiles that are group/world readable or not owned
# by the mongod user, so permissions are fixed on every start. Then hands over to the official
# docker-entrypoint.sh (which creates the root user from MONGO_INITDB_ROOT_* on an empty data dir).
set -euo pipefail

KEYFILE="${MONGO_KEYFILE_PATH:-/etc/mongo-keyfile/keyfile}"
mkdir -p "$(dirname "$KEYFILE")"
if [ ! -s "$KEYFILE" ]; then
  echo "keyfile.sh: generating replica-set keyfile at $KEYFILE"
  head -c 756 /dev/urandom | base64 | tr -d '\n' > "$KEYFILE"
fi
chown mongodb:mongodb "$KEYFILE"
chmod 400 "$KEYFILE"

exec /usr/local/bin/docker-entrypoint.sh "$@" --keyFile "$KEYFILE"
