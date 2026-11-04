// Move the existing Orderdesk data from the old encrypted single-blob database
// (neworderschedule …/orderdesk/v1/state) into the new structured database.
//
//   ORDERDESK_KEY=<64 hex chars from the old Sites deployment> \
//   node --env-file=.env scripts/migrate-legacy.mjs [--force]
//
// LEGACY_STATE_URL overrides the source; LEGACY_STATE_FILE=<path> reads a
// downloaded copy of that JSON node instead of fetching it.
import { readFile } from 'node:fs/promises';
import { unseal, DB_URL } from '../lib/crypto-store.mjs';
import { store, firebase, ensureEmpty, counts } from './_store.mjs';
const key = process.env.ORDERDESK_KEY;
if (!/^[a-f0-9]{64}$/i.test(key || '')) { console.error('Set ORDERDESK_KEY to the old 64-character hex key.'); process.exit(1); }
const sealed = process.env.LEGACY_STATE_FILE
  ? JSON.parse(await readFile(process.env.LEGACY_STATE_FILE, 'utf8'))
  : await (async () => { const r = await fetch(process.env.LEGACY_STATE_URL || DB_URL); if (!r.ok) throw new Error('Legacy read failed: HTTP ' + r.status); return r.json(); })();
if (!sealed) throw new Error('Legacy database is empty');
const state = await unseal(sealed, key);
console.log('Legacy state decrypted:', counts(state));
const etag = await ensureEmpty();
await store.writeState(state, etag);
const check = (await (await import('../server/store.mjs')).createStore(firebase, { root: process.env.FIREBASE_ROOT || 'orderdesk/v2' }).readState()).state;
if (JSON.stringify(check) !== JSON.stringify(state)) throw new Error('Read-back differs from the legacy state; investigate before using the site');
console.log('Migrated and verified:', counts(check));
