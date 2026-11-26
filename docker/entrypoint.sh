#!/bin/sh
# Run Mammatus as PUID:PGID (Unraid defaults 99:100) with a writable /data.
set -e
PUID="${PUID:-99}"
PGID="${PGID:-100}"
DATA="${MAMMATUS_DATA_DIR:-/data}"
mkdir -p "$DATA"
if [ "$(id -u)" = "0" ]; then
  # only touch ownership when it is wrong (fast on big caches)
  if [ "$(stat -c %u:%g "$DATA")" != "$PUID:$PGID" ]; then
    chown -R "$PUID:$PGID" "$DATA" || echo "warning: could not chown $DATA"
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- python -m mammatus "$@"
fi
exec python -m mammatus "$@"
