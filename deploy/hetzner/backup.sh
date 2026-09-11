#!/usr/bin/env bash
# Nightly backup of the Barraqueiro Legal Assistant volume: a VACUUM'd SQLite snapshot
# (consistent even mid-write) plus the content-addressed files (originals, versions,
# PDFs, OAuth state). Keeps the last 14. Installed on the VM's root crontab:
#   30 3 * * * /opt/naten/deploy/clients/barraqueiro-legal/backup.sh >> /var/log/legal-backup.log 2>&1
set -euo pipefail

CONTAINER=naten-barraqueiro-legal
DEST=/root/backups/barraqueiro-legal
mkdir -p "$DEST"

docker exec "$CONTAINER" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  fs.rmSync('/data-home/backup.sqlite', { force: true });
  const db = new DatabaseSync('/data-home/legal-assistant.sqlite');
  db.exec(\"VACUUM INTO '/data-home/backup.sqlite'\");
  db.close();
"
docker exec "$CONTAINER" tar -czf - -C /data-home backup.sqlite files oauth-state 2>/dev/null \
  > "$DEST/legal-$(date +%F-%H%M).tar.gz"
docker exec "$CONTAINER" rm -f /data-home/backup.sqlite

ls -t "$DEST"/legal-*.tar.gz | tail -n +15 | xargs -r rm --
echo "$(date -Is) backup ok: $(ls -t "$DEST"/legal-*.tar.gz | head -1)"
