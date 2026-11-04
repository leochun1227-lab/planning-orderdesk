// Restore a full state JSON (from export-state.mjs, or a decrypted legacy state):
//   node --env-file=.env scripts/import-state.mjs backup.json [--force]
import { readFile } from 'node:fs/promises';
import { store, ensureEmpty, counts } from './_store.mjs';
const file = process.argv.filter(a => !a.startsWith('--'))[2];
if (!file) { console.error('Usage: import-state.mjs <state.json> [--force]'); process.exit(1); }
const state = JSON.parse(await readFile(file, 'utf8'));
if (!state.orders || !state.meta) throw new Error('Not an Orderdesk state file (needs orders and meta)');
const etag = await ensureEmpty();
await store.writeState(state, etag);
console.log('Imported:', counts(state));
