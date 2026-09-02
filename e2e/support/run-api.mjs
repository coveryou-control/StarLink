/**
 * Starts the API for the browser suite and tees its stdout to a file.
 *
 * The tee is not a convenience. The dev OTP sink prints
 * `[dev-otp] SMS -> +91…: 123456` to stdout and nowhere else — the code is never stored
 * (only an HMAC is) and never appears in a response body, which is the correct design.
 * A browser cannot read a parent process's stdout, so the customer journey needs the
 * line on disk to type the real code into the real form. Everything else about the
 * process is unchanged: this is the same `dist/main.js` production runs.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const logPath = resolve(repoRoot, '.playwright', 'api.log');

mkdirSync(dirname(logPath), { recursive: true });
// Truncate, so a test never matches a code issued by a previous run.
writeFileSync(logPath, '');
const log = createWriteStream(logPath, { flags: 'a' });

const api = spawn(process.execPath, [resolve(repoRoot, 'apps', 'api', 'dist', 'main.js')], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

api.stdout.pipe(log);
api.stdout.pipe(process.stdout);
api.stderr.pipe(log);
api.stderr.pipe(process.stderr);

const stop = () => {
  if (api.exitCode === null) api.kill();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
api.on('exit', (code) => process.exit(code ?? 0));
