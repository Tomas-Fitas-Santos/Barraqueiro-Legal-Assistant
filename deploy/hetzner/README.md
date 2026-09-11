# Deploying to the shared Hetzner VM

One container behind the shared edge Caddy. Release flow:

1. `gh workflow run "Publish Legal Assistant Image" --ref main` and wait for the
   run OF THE INTENDED SHA to finish (check the run's head sha, not just the latest run).
2. On the VM (`/opt/naten/deploy/clients/barraqueiro-legal/`): set `LEGAL_IMAGE` in `.env`
   to `ghcr.io/natenai/legal-assistant:<sha>` (always sha-pinned) and
   `docker compose up -d`.
3. Edge Caddy (`/opt/naten/deploy/proxy/Caddyfile`) carries:

       barraqueiro-legal.naten.ai {
         reverse_proxy naten-barraqueiro-legal:3000
       }

   Reload with `docker exec naten-proxy-caddy-1 caddy reload --config /etc/caddy/Caddyfile`.
4. DNS: `barraqueiro-legal.naten.ai` A → the VM's IP (no wildcard exists on naten.ai).

Data (SQLite, originals, OAuth state) lives in the named `data` volume. Before any
schema-changing deploy: `docker exec naten-barraqueiro-legal node -e "require('node:sqlite').DatabaseSync && 0"` —
and take a backup: `docker run --rm -v barraqueiro-legal_data:/d -v /root/backups:/b alpine cp /d/legal-assistant.sqlite /b/legal-$(date +%F).sqlite`.
