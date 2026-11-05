// Structured, incremental persistence of the Orderdesk state in Firebase.
//
// The business engine (lib/order-engine.mjs etc.) still works on one in-memory
// state object exactly as before: {orders, events, imports, meta, refs, ...}.
// What changed is only how that object is stored:
//
//   <root>/revision           number, bumped atomically with every save
//   <root>/savedAt            ISO time of the last save
//   <root>/orders/<id>        one node per order    (readable in the console)
//   <root>/events/<id>        one node per change-log event
//   <root>/imports/<id>       one node per processed report
//   <root>/meta               report dates, sync status
//   <root>/blobs/<name>       large reference data (refs, productionSources,
//                             orderlistExport, baselineOrders...) as gzip+base64
//
// A save writes only the nodes whose content changed, in ONE multi-path PATCH
// (atomic in Firebase), together with revision+1. The revision plays the role
// of the old ETag: a save based on an outdated read is rejected with the same
// "数据已被更新，请刷新后重试" error as before.
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { reconcileSchedule } from '../lib/schedule.mjs';

export const COLLECTIONS = ['orders', 'events', 'imports'];
const RECORD_KEYS = new Set([...COLLECTIONS, 'meta']);
export const STALE_MESSAGE = '数据已被更新，请刷新后重试';

// ---- lossless codec for Firebase (no nulls / empty containers / bad keys) ----
const NULL = '%%null', EMPTY_ARRAY = '%%[]', EMPTY_OBJECT = '%%{}', STRING = '%%s';
const escapeKey = k => (/^\d+$/.test(k) ? '%N' : '') + k.replace(/[%.#$\[\]\/]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const unescapeKey = k => (k.startsWith('%N') ? k.slice(2) : k).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
export function encode(value) {
  if (value === null || value === undefined) return NULL;
  if (typeof value === 'string') return value.startsWith('%%') ? STRING + value : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NULL;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.length ? value.map(encode) : EMPTY_ARRAY;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length ? Object.fromEntries(entries.map(([k, v]) => [escapeKey(k), encode(v)])) : EMPTY_OBJECT;
}
export function decode(value) {
  if (value === NULL || value === null || value === undefined) return null;
  if (value === EMPTY_ARRAY) return [];
  if (value === EMPTY_OBJECT) return {};
  if (typeof value === 'string') return value.startsWith(STRING) ? value.slice(STRING.length) : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decode);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [unescapeKey(k), decode(v)]));
}
const packBlob = value => gzipSync(Buffer.from(JSON.stringify(value ?? null))).toString('base64');
const unpackBlob = text => JSON.parse(gunzipSync(Buffer.from(text, 'base64')).toString('utf8'));
const digest = text => createHash('sha1').update(text).digest('base64');

// One writer at a time inside this process (browser imports, Planning PC agent
// and the mail scheduler all go through here).
function createMutex() {
  let tail = Promise.resolve();
  return fn => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
}

export function createStore(firebase, { root = 'orderdesk/v2' } = {}) {
  const base = root.split('/').filter(Boolean).join('/');
  const path = p => base + '/' + p;
  const exclusive = createMutex();
  // Cache of the last loaded/saved revision: decoded state plus per-node
  // fingerprints used to compute the diff for the next save.
  let cache = null;
  let payloadCache = null;

  async function remoteRevision() { return Number(await firebase.get(path('revision'))) || 0; }

  async function load() {
    const raw = (await firebase.get(base)) || {};
    const revision = Number(raw.revision) || 0;
    const state = {}, prints = {};
    for (const name of COLLECTIONS) {
      state[name] = {}; prints[name] = {};
      for (const [k, v] of Object.entries(raw[name] || {})) {
        const id = unescapeKey(k), record = decode(v);
        state[name][id] = record; prints[name][id] = digest(JSON.stringify(record));
      }
    }
    if (raw.meta !== undefined) { state.meta = decode(raw.meta); prints.meta = digest(JSON.stringify(state.meta)); }
    prints.blobs = {};
    for (const [k, v] of Object.entries(raw.blobs || {})) {
      const name = unescapeKey(k); state[name] = unpackBlob(v); prints.blobs[name] = digest(v);
    }
    const empty = !revision && !Object.keys(raw).length;
    cache = { revision, state: empty ? null : state, prints, savedAt: raw.savedAt || null };
    payloadCache = null;
    return cache;
  }

  async function current() {
    const revision = await remoteRevision();
    if (!cache || cache.revision !== revision) await load();
    return cache;
  }

  /** Same contract as the old crypto-store readState: {state, etag}. */
  async function readState() {
    const c = await current();
    return { state: c.state ? structuredClone(c.state) : null, etag: String(c.revision) };
  }

  function diff(next, prints) {
    const updates = {}, nextPrints = { blobs: {} };
    let changed = 0;
    for (const name of COLLECTIONS) {
      nextPrints[name] = {};
      const records = next[name] || {}, before = prints?.[name] || {};
      for (const [id, record] of Object.entries(records)) {
        const print = digest(JSON.stringify(record));
        nextPrints[name][id] = print;
        if (before[id] !== print) { updates[`${name}/${escapeKey(id)}`] = encode(record); changed++; }
      }
      for (const id of Object.keys(before)) if (!(id in records)) { updates[`${name}/${escapeKey(id)}`] = null; changed++; }
    }
    if (next.meta !== undefined) {
      nextPrints.meta = digest(JSON.stringify(next.meta));
      if (prints?.meta !== nextPrints.meta) { updates.meta = encode(next.meta); changed++; }
    }
    for (const [name, value] of Object.entries(next)) {
      if (RECORD_KEYS.has(name) || value === undefined) continue;
      const packed = packBlob(value), print = digest(packed);
      nextPrints.blobs[name] = print;
      if (prints?.blobs?.[name] !== print) { updates[`blobs/${escapeKey(name)}`] = packed; changed++; }
    }
    for (const name of Object.keys(prints?.blobs || {})) if (!(name in next) || next[name] === undefined) { updates[`blobs/${escapeKey(name)}`] = null; changed++; }
    return { updates, nextPrints, changed };
  }

  /** Same contract as the old writeState(state, secret, etag). */
  function writeState(next, etag) {
    return exclusive(async () => {
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('数据库内容无效');
      const remote = await remoteRevision();
      if (etag !== undefined && etag !== null && String(remote) !== String(etag)) throw new Error(STALE_MESSAGE);
      if (!cache || cache.revision !== remote) await load();
      // Slot rules (new order -> dealer's earliest empty slot, cancellation frees its row)
      // apply to every save, whichever path produced it.
      next = reconcileSchedule(cache.state, next);
      const { updates, nextPrints, changed } = diff(next, cache.prints);
      if (!changed && cache.state) return { revision: remote, changed: 0 };
      const revision = remote + 1, savedAt = new Date().toISOString();
      try {
        await firebase.patch(base, { ...updates, revision, savedAt });
      } catch (e) {
        cache = null; payloadCache = null;
        throw new Error('数据库保存失败: ' + (e instanceof Error ? e.message : String(e)));
      }
      cache = { revision, state: structuredClone(next), prints: nextPrints, savedAt };
      payloadCache = null;
      return { revision, changed };
    });
  }

  /** Serialized /api/orders body, cached per revision. */
  async function ordersPayload() {
    const c = await current();
    if (!c.state) return null;
    if (!payloadCache || payloadCache.revision !== c.revision) {
      const { orders = {}, events = {}, imports = {}, meta = {}, schedule = null, calendar = null } = c.state;
      const sched = schedule ? { rows: schedule.rows.map(r => [r.chassis, r.dealer]), pending: schedule.pending || [], source: schedule.source || null } : null;
      payloadCache = { revision: c.revision, body: JSON.stringify({ orders: Object.values(orders), events: Object.values(events), imports: Object.values(imports), meta, schedule: sched, calendar, revision: c.revision }) };
    }
    return payloadCache;
  }

  return { readState, writeState, ordersPayload, revision: remoteRevision, exclusive, info: () => ({ root: base, backend: firebase.kind, url: firebase.url, revision: cache?.revision ?? null, savedAt: cache?.savedAt ?? null }) };
}
