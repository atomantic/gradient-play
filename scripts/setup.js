#!/usr/bin/env node
// One-shot setup: install all deps, seed .env, build the client.
// After this finishes, `npm start` serves the full app on a single port.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const step = (msg) => console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
const warn = (msg) => console.log(`\x1b[33m! ${msg}\x1b[0m`);

const run = (cmd, args, cwd) => {
  const label = `${cmd} ${args.join(' ')}`;
  console.log(`  $ ${label}  (in ${cwd.replace(ROOT, '.') || '.'})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n\x1b[31m✗ Command failed: ${label}\x1b[0m`);
    process.exit(r.status || 1);
  }
};

// 1. Node version guard
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`\x1b[31m✗ Node ${process.versions.node} detected — need Node 20+.\x1b[0m`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// 2. Install deps (root + server + client)
step('Installing dependencies');
run('npm', ['install'], ROOT);
run('npm', ['install'], resolve(ROOT, 'server'));
run('npm', ['install'], resolve(ROOT, 'client'));
ok('Dependencies installed');

// 3. Seed .env from .env.example (non-destructive)
step('Seeding .env');
const envPath = resolve(ROOT, '.env');
const examplePath = resolve(ROOT, '.env.example');
if (existsSync(envPath)) {
  ok('.env already exists — leaving it alone');
} else if (existsSync(examplePath)) {
  copyFileSync(examplePath, envPath);
  ok('.env created from .env.example');
} else {
  warn('.env.example not found — skipping');
}

// 4. Build client
step('Building client');
run('npm', ['run', 'build'], resolve(ROOT, 'client'));
ok('Client built → client/dist/');

// 5. Read PORT/HOST from .env for the final message
let port = '5572';
let host = '127.0.0.1';
if (existsSync(envPath)) {
  const env = readFileSync(envPath, 'utf8');
  const m = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim();
  port = m('PORT') || port;
  host = m('HOST') || host;
}

console.log(`
\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Setup complete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m

  Start the app:
    \x1b[36mnpm start\x1b[0m

  Then open:
    \x1b[36mhttp://${host}:${port}/\x1b[0m

  Make sure Chrome is running with --remote-debugging-port=5556
  and logged into https://game.gradient-bang.com.

  For development with HMR instead:
    \x1b[36mnpm run dev\x1b[0m   # UI on :5571, API on :${port}
`);
