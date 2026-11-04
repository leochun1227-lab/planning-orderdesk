// Shared by the command-line scripts: same Firebase store the server uses.
// Reads the same environment variables (FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT,
// FIREBASE_DATABASE_SECRET, FIREBASE_ROOT). Put them in a local .env and run
// `node --env-file=.env scripts/<name>.mjs`.
import { createFirebase } from '../server/firebase.mjs';
import { createStore } from '../server/store.mjs';
export const firebase = createFirebase(process.env);
export const store = createStore(firebase, { root: process.env.FIREBASE_ROOT || 'orderdesk/v2' });
export const force = process.argv.includes('--force');
export async function ensureEmpty() {
  const { state, etag } = await store.readState();
  if (state && !force) { console.error(`Target already has data (${Object.keys(state.orders || {}).length} orders). Re-run with --force to overwrite.`); process.exit(1); }
  return etag;
}
export const counts = s => ({ orders: Object.keys(s.orders || {}).length, events: Object.keys(s.events || {}).length, imports: Object.keys(s.imports || {}).length });
