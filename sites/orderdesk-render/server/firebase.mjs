// Firebase Realtime Database access over REST, used only by this server.
// Auth (first match wins):
//   FIREBASE_SERVICE_ACCOUNT  service-account JSON (raw or base64) — recommended
//   FIREBASE_DATABASE_SECRET  legacy database secret
//   (none)                    unauthenticated; only works while rules allow it
// FIREBASE_DATABASE_URL=memory:// gives an in-process database for local tests.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const DEFAULT_DATABASE_URL = 'https://planningorderdesk-default-rtdb.asia-southeast1.firebasedatabase.app';

export class FirebaseError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function serviceAccount(raw) {
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text);
  if (!json.client_email || !json.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is not a service-account JSON key');
  return json;
}

export function createFirebase(env = process.env) {
  const configured = env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL;
  if (configured.startsWith('memory:')) return createMemoryFirebase(env.LOCAL_DB_FILE);
  const url = configured.replace(/\/+$/, '');
  const account = serviceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  const secret = env.FIREBASE_DATABASE_SECRET || '';
  let client = null;
  async function authHeaders() {
    if (!account) return {};
    if (!client) {
      const { JWT } = await import('google-auth-library');
      client = new JWT({ email: account.client_email, key: account.private_key, scopes: ['https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email'] });
    }
    const { token } = await client.getAccessToken();
    return { Authorization: 'Bearer ' + token };
  }
  const endpoint = (path, query = {}) => {
    const u = new URL(url + '/' + path.split('/').filter(Boolean).map(encodeURIComponent).join('/') + '.json');
    if (secret && !account) u.searchParams.set('auth', secret);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  };
  async function call(method, path, body, query) {
    const response = await fetch(endpoint(path, query), {
      method, signal: AbortSignal.timeout(120000),
      headers: { ...(await authHeaders()), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new FirebaseError(response.status === 401 || response.status === 403 ? 'Firebase 拒绝访问，请检查服务账号或数据库规则' : `Firebase ${method} 失败 (${response.status}): ${text}`, response.status);
    }
    return response.json();
  }
  return {
    kind: account ? 'service-account' : secret ? 'database-secret' : 'unauthenticated',
    url,
    get: (path, query) => call('GET', path, undefined, query),
    patch: (path, value) => call('PATCH', path, value),
    put: (path, value) => call('PUT', path, value),
  };
}

// ---------- In-memory database with Firebase's storage semantics ----------
// Nulls are dropped, empty objects disappear, arrays become index-keyed objects
// and come back as arrays only when they look like arrays. Tests use this to
// prove the store's encoding survives a real Realtime Database round trip.
export function firebaseStore(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) value = Object.fromEntries(value.map((v, i) => [String(i), v]));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/[.#$\[\]\/]/.test(k) || !k) throw new FirebaseError(`Invalid Firebase key: ${k}`, 400);
      const stored = firebaseStore(v);
      if (stored !== undefined) out[k] = stored;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}
export function firebaseRead(value) {
  if (value === null || typeof value !== 'object') return value ?? null;
  const keys = Object.keys(value);
  const ints = keys.every(k => /^(0|[1-9]\d*)$/.test(k));
  if (ints && keys.length) {
    const max = Math.max(...keys.map(Number));
    if (keys.length > max / 2) return Array.from({ length: max + 1 }, (_, i) => firebaseRead(value[i] ?? null));
  }
  return Object.fromEntries(keys.map(k => [k, firebaseRead(value[k])]));
}
export function createMemoryFirebase(file) {
  let root = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const parts = path => path.split('/').filter(Boolean);
  const save = () => { if (file) writeFileSync(file, JSON.stringify(root)); };
  function at(path) { let node = root; for (const p of parts(path)) { if (!node || typeof node !== 'object') return null; node = node[p]; } return node ?? null; }
  function set(path, value) {
    const ps = parts(path);
    if (!ps.length) { root = firebaseStore(value) || {}; return; }
    let node = root;
    for (const p of ps.slice(0, -1)) { if (!node[p] || typeof node[p] !== 'object') node[p] = {}; node = node[p]; }
    const stored = firebaseStore(value);
    if (stored === undefined) delete node[ps.at(-1)]; else node[ps.at(-1)] = stored;
  }
  const prune = () => { root = firebaseStore(root) || {}; };
  return {
    kind: 'memory', url: 'memory://',
    async get(path, query = {}) {
      const value = at(path);
      if (query.shallow === 'true' && value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(k => [k, true]));
      return structuredClone(firebaseRead(value));
    },
    async patch(path, value) {
      // Multi-path update: atomic in the real database, atomic here too.
      for (const [k, v] of Object.entries(value)) set(parts(path).concat(parts(k)).join('/'), v);
      prune(); save(); return value;
    },
    async put(path, value) { set(path, value); prune(); save(); return value; },
    dump: () => structuredClone(root),
  };
}
