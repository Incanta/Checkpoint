#!/bin/sh
# Runtime entrypoint.
#
# bootstrap.js exits 0 both when the component stopped normally and when it
# asked to be restarted onto a newly staged bundle. Distinguishing those from
# inside the container is not possible, so the restart policy has to do it:
# the compose file and the docs both specify `restart: unless-stopped`.
#
# Without a restart policy, "install update" from the admin panel stops the
# service instead of upgrading it. Warn loudly rather than let that surprise
# someone mid-upgrade.

set -e

if [ -z "$CHECKPOINT_COMPONENT" ]; then
  echo "[entrypoint] FATAL CHECKPOINT_COMPONENT is not set (expected 'app' or 'server')" >&2
  exit 1
fi

echo "[entrypoint] Checkpoint runtime starting: component=$CHECKPOINT_COMPONENT"

exec node /app/runtime/bootstrap.js
