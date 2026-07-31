#!/usr/bin/env bash
# Build, pack, ship, install and restart. Requires sshpass and a .env (see .env.example).
#
# Verified layout: Homebridge runs in Docker container "homebridge"; its storage
# dir /var/lib/homebridge resolves to /homebridge in the container, which is the
# host directory /mnt/cache/appdata/homebridge. Plugins install into the
# container's global npm root, /opt/homebridge/lib/node_modules.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${UNRAID_HOST:?missing in .env}"
: "${UNRAID_USER:?missing in .env}"
: "${UNRAID_PASS:?missing in .env}"

CONTAINER=homebridge
HOST_DIR=/mnt/cache/appdata/homebridge   # == /homebridge inside the container

command -v sshpass >/dev/null || { echo "error: sshpass not installed (brew install hudochenkov/sshpass/sshpass)" >&2; exit 1; }

# Never expands the password into the process table of the remote host.
remote() { sshpass -p "$UNRAID_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$UNRAID_USER@$UNRAID_HOST" "$@"; }

echo "==> Build"
npm run build

echo "==> Pack"
TARBALL=$(npm pack --silent)
trap 'rm -f "$TARBALL"' EXIT
echo "    $TARBALL"

echo "==> Ship to $UNRAID_HOST:$HOST_DIR"
sshpass -p "$UNRAID_PASS" scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
  "$TARBALL" "$UNRAID_USER@$UNRAID_HOST:$HOST_DIR/$TARBALL"

echo "==> Install inside container"
# --omit=dev so the container does not pull our test/build toolchain.
remote "docker exec $CONTAINER npm install -g --omit=dev /homebridge/$TARBALL"

echo "==> Clean up tarball on host"
remote "rm -f $HOST_DIR/$TARBALL"

echo "==> Restart Homebridge"
remote "docker restart $CONTAINER" >/dev/null

echo "==> Wait for it to come back"
for _ in $(seq 1 30); do
  if remote "docker exec $CONTAINER true" 2>/dev/null; then break; fi
  sleep 2
done

echo "==> Done. Recent log:"
remote "docker logs --tail 40 $CONTAINER" 2>&1 | sed 's/^/    /'
