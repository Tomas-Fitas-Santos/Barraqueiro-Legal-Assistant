#!/usr/bin/env node
// Run the production build the SAME way the container image does — via the Next.js standalone
// server (`node .next/standalone/server.js`) rather than `next start`. This keeps the local
// systemd deploy and the ghcr image (see Dockerfile) on one identical run path, so behaviour
// can't drift between "local prod" and "real prod".
//
// The standalone bundle does process.chdir() into .next/standalone and does NOT ship the static
// assets, public/, or .env on its own (the Dockerfile COPYs them in). We do the equivalent sync
// here so the server finds its assets and loads env from the right place.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(projectRoot, '.next', 'standalone');

if (!existsSync(join(standalone, 'server.js'))) {
  console.error('[start] .next/standalone/server.js missing — run `npm run build` first.');
  process.exit(1);
}

function sync(from, to) {
  if (!existsSync(from)) return;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

// Assets the standalone bundle does not include itself (mirrors the Dockerfile COPY steps).
sync(join(projectRoot, '.next', 'static'), join(standalone, '.next', 'static'));
sync(join(projectRoot, 'public'), join(standalone, 'public'));
// server.js chdir()s into .next/standalone, so @next/env loads .env from there — put it in place.
if (existsSync(join(projectRoot, '.env'))) cpSync(join(projectRoot, '.env'), join(standalone, '.env'));

// CLI convenience: accept `-H <host>` / `-p <port>` like `next start` and map them onto the env
// vars the standalone server reads (already-set env still wins, matching the container's ENV).
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '-H' || argv[i] === '--hostname') && argv[i + 1]) process.env.HOSTNAME = argv[++i];
  else if ((argv[i] === '-p' || argv[i] === '--port') && argv[i + 1]) process.env.PORT = argv[++i];
}

const child = spawn(process.execPath, ['server.js'], { cwd: standalone, stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
