/**
 * Credential storage.
 *
 * Primary: macOS Keychain via `security add-generic-password`.
 *   - Service: "gradient-play"
 *   - Account: the email address
 *   - Nothing ever written to the repo or data dir in plaintext.
 *
 * Fallback (non-macOS): AES-256-GCM encrypted file at server/data/credentials.enc.
 *   Encryption key lives at ~/.config/gradient-play/key (mode 0600), auto-generated.
 *   Data dir is gitignored.
 *
 * Stored value is a JSON object: { email, password }.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const ENC_FILE = path.join(DATA_DIR, 'credentials.enc');
const KEY_DIR = path.join(os.homedir(), '.config', 'gradient-play');
const KEY_FILE = path.join(KEY_DIR, 'key');
const KEYCHAIN_SERVICE = 'gradient-play';
const ACCOUNT_MARKER = path.join(DATA_DIR, 'account.txt');

const isDarwin = process.platform === 'darwin';

const readAccount = () => {
  if (!fs.existsSync(ACCOUNT_MARKER)) return null;
  return fs.readFileSync(ACCOUNT_MARKER, 'utf8').trim() || null;
};

const writeAccount = (email) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_MARKER, email, { mode: 0o600 });
};

const clearAccount = () => {
  if (fs.existsSync(ACCOUNT_MARKER)) fs.unlinkSync(ACCOUNT_MARKER);
};

const keychainSet = (email, password) => {
  const r = spawnSync('security', [
    'add-generic-password',
    '-U',
    '-s', KEYCHAIN_SERVICE,
    '-a', email,
    '-w', password
  ]);
  if (r.status !== 0) throw new Error(`keychain write failed: ${r.stderr?.toString() || r.status}`);
};

const keychainGet = (email) => {
  const r = spawnSync('security', [
    'find-generic-password',
    '-s', KEYCHAIN_SERVICE,
    '-a', email,
    '-w'
  ]);
  if (r.status !== 0) return null;
  return r.stdout.toString().replace(/\n$/, '');
};

const keychainDelete = (email) => {
  spawnSync('security', [
    'delete-generic-password',
    '-s', KEYCHAIN_SERVICE,
    '-a', email
  ]);
};

const ensureKey = () => {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(KEY_FILE);
};

const fileSet = (email, password) => {
  const key = ensureKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({ email, password });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ENC_FILE, Buffer.concat([iv, tag, enc]), { mode: 0o600 });
};

const fileGet = () => {
  if (!fs.existsSync(ENC_FILE)) return null;
  const key = ensureKey();
  const buf = fs.readFileSync(ENC_FILE);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
};

const fileDelete = () => {
  if (fs.existsSync(ENC_FILE)) fs.unlinkSync(ENC_FILE);
};

export const setCredentials = ({ email, password }) => {
  if (!email || !password) throw new Error('email and password required');
  const existing = readAccount();
  if (existing && existing !== email) {
    if (isDarwin) keychainDelete(existing);
  }
  if (isDarwin) {
    keychainSet(email, password);
  } else {
    fileSet(email, password);
  }
  writeAccount(email);
  return { ok: true, backend: isDarwin ? 'keychain' : 'file' };
};

export const getCredentials = () => {
  const email = readAccount();
  if (!email) return null;
  if (isDarwin) {
    const password = keychainGet(email);
    if (!password) return null;
    return { email, password };
  }
  return fileGet();
};

export const clearCredentials = () => {
  const email = readAccount();
  if (email && isDarwin) keychainDelete(email);
  else fileDelete();
  clearAccount();
  return { ok: true };
};

export const credentialsStatus = () => {
  const email = readAccount();
  const backend = isDarwin ? 'keychain' : 'file';
  return {
    configured: !!email && !!getCredentials(),
    email: email || null,
    backend
  };
};
