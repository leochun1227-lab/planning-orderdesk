// Backup: node --env-file=.env scripts/export-state.mjs backup.json
import { writeFile } from 'node:fs/promises';
import { store, counts } from './_store.mjs';
const file = process.argv[2] || `orderdesk-backup-${new Date().toISOString().slice(0, 10)}.json`;
const { state, etag } = await store.readState();
if (!state) { console.error('Database is empty'); process.exit(1); }
await writeFile(file, JSON.stringify(state));
console.log(`Saved revision ${etag} to ${file}:`, counts(state));
