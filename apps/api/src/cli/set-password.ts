// Asks for the dashboard password (typed characters shown as *), hashes it, and writes
// ADMIN_PASSWORD_HASH into .env.
//   npm run set-password
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { ROOT_DIR } from '@ja/shared';

const MIN_LENGTH = 10;
const BOM = 0xfeff;
// SET_PASSWORD_ENV_FILE lets tests point at a throwaway file instead of the real .env.
const envPath = process.env.SET_PASSWORD_ENV_FILE ?? path.join(ROOT_DIR, '.env');

// One readline interface for both questions, so typed and piped input both work.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
});
const queued: string[] = [];
const waiting: Array<(line: string) => void> = [];
rl.on('line', (raw) => {
  // Windows PowerShell may prefix piped input with a BOM and leave a trailing CR.
  const line = (raw.charCodeAt(0) === BOM ? raw.slice(1) : raw).replace(/\r$/, '');
  const next = waiting.shift();
  if (next) next(line);
  else queued.push(line);
});
rl.on('close', () => {
  if (waiting.length) {
    console.error('\nNo input received. Run this in an interactive terminal: npm run set-password');
    process.exit(1);
  }
});

// Echo typed characters as "*" instead of the password itself.
let masking = false;
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
  if (!masking) process.stdout.write(s);
  else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
  else process.stdout.write('*'.repeat(s.length));
};

function askHidden(question: string): Promise<string> {
  masking = false;
  process.stdout.write(question);
  masking = true;
  const line = queued.shift();
  return line !== undefined
    ? Promise.resolve(line)
    : new Promise((resolve) => waiting.push(resolve));
}

function fail(message: string): never {
  console.error(`\n${message}`);
  rl.close();
  process.exit(1);
}

if (!fs.existsSync(envPath)) fail(`No .env found at ${envPath}. Copy .env.example to .env first.`);

const password = await askHidden(`New dashboard password (min ${MIN_LENGTH} characters): `);
if (password.length < MIN_LENGTH) fail(`Too short: use at least ${MIN_LENGTH} characters.`);
const again = await askHidden('Type it again: ');
if (again !== password) fail('The two passwords did not match. Nothing was changed.');
rl.close();

const hash = await bcrypt.hash(password, 12);
const line = `ADMIN_PASSWORD_HASH='${hash}'`;
const content = fs.readFileSync(envPath, 'utf8');
const updated = /^ADMIN_PASSWORD_HASH=.*$/m.test(content)
  ? content.replace(/^ADMIN_PASSWORD_HASH=.*$/m, () => line)
  : `${content.trimEnd()}\n${line}\n`;
fs.writeFileSync(envPath, updated);

console.log(`\nSaved ADMIN_PASSWORD_HASH to ${envPath}.`);
console.log('Restart "npm run dev" (or the API) for the new password to take effect.');
