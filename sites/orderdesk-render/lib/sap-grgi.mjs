// SAP GR / GI per chassis, pushed by a computer inside the company network (SAP HANA is not
// reachable from Render). The computer runs the same SQL as the Planning Schedule workbook's
// queries posts {gr, fg, gi}: goods receipts found by the chassis serial number on the material document
// (SER03 + OBJK), and PGI as in the Planning Schedule workbook's Power Query "PGI".
// This is the only GR / GI source of the production line (no Portal copies).
// Stored compactly at orderdesk/sap-grgi (outside the order state, so order saves never load it).
import { normalizeChassis } from './order-engine.mjs';

export const SAP_PATH = 'orderdesk/sap-grgi';
export const SAP_MAX_BYTES = 20 * 1024 * 1024;
const day = v => { const s = String(v ?? '').trim(); const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/); return m && m[1] > '1971' ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const clean = v => String(v ?? '').replace(/[|\s]+/g, ' ').trim().slice(0, 20);

/**
 * Validate an upload and fold it per chassis (the latest of each kind wins):
 *   gr [chassis, date, po, doc]  goods receipt 101 at plant 3111 WITH a purchase order (received from Longtree)
 *   fg [chassis, date, doc]      goods receipt 101 at plant 3111 WITHOUT a PO (AU production finished)
 *   gi [chassis, date, doc]      PGI 601 at plant 3111
 */
export function foldSapUpload(body) {
  if (!body || !Array.isArray(body.gr) || !Array.isArray(body.gi)) throw new Error('gr and gi arrays are required');
  const fgIn = Array.isArray(body.fg) ? body.fg : [];
  if (body.gr.length + body.gi.length + fgIn.length > 300000) throw new Error('too many rows');
  const rows = new Map();
  const row = c => rows.get(c) || rows.set(c, { grAt: '', po: '', grDoc: '', fgAt: '', fgDoc: '', giAt: '', giDoc: '' }).get(c);
  const take = (list, dateField, apply) => { let n = 0; for (const r of list) {
    if (!Array.isArray(r)) continue;
    const c = normalizeChassis(r[0]), d = day(r[1]);
    if (!c || !/^[A-Z0-9]{4,20}$/.test(c) || !d) continue;
    const x = row(c); if (d >= x[dateField]) apply(x, d, r); n++; } return n; };
  const gr = take(body.gr, 'grAt', (x, d, r) => { x.grAt = d; x.po = clean(r[2]); x.grDoc = clean(r[3]); });
  const fg = take(fgIn, 'fgAt', (x, d, r) => { x.fgAt = d; x.fgDoc = clean(r[2]); });
  const gi = take(body.gi, 'giAt', (x, d, r) => { x.giAt = d; x.giDoc = clean(r[2]); });
  return { rows, gr, fg, gi };
}
const FIELDS = ['grAt', 'po', 'grDoc', 'fgAt', 'fgDoc', 'giAt', 'giDoc'];
export const encodeSap = rows => Object.fromEntries([...rows].map(([c, x]) => [c, FIELDS.map(f => x[f]).join('|')]));
const OLD_FIELDS = ['grAt', 'po', '', 'giAt', 'giDoc']; // first upload format (5 parts), read until the next push replaces it
export const decodeSap = obj => new Map(Object.entries(obj || {}).map(([c, s]) => { const v = String(s).split('|'), names = v.length === 5 ? OLD_FIELDS : FIELDS;
  const x = Object.fromEntries(FIELDS.map(f => [f, ''])); names.forEach((f, i) => { if (f) x[f] = v[i] || ''; }); return [c, x]; }));

/** Reads the stored SAP copy (cached; refreshed after an upload or every 10 minutes). */
export function createSapSource(firebase, { path = SAP_PATH, ttlMs = 10 * 60 * 1000 } = {}) {
  let cache = null, loadedAt = 0;
  return {
    async current() {
      if (!firebase) return { rows: new Map(), at: '', count: 0, error: 'not configured' };
      if (!cache || Date.now() - loadedAt > ttlMs) {
        try { const v = (await firebase.get(path)) || {}; cache = { rows: decodeSap(v.rows), at: v.at || '', count: Number(v.count) || 0, error: v.at ? '' : 'no upload yet' }; }
        catch (e) { cache = { ...(cache || { rows: new Map(), at: '', count: 0 }), error: e instanceof Error ? e.message : String(e) }; }
        loadedAt = Date.now();
      }
      return cache;
    },
    async save(upload, now = new Date()) {
      if (!firebase) throw new Error('Database not configured');
      const { rows, gr, fg, gi } = foldSapUpload(upload);
      if (!rows.size) throw new Error('No GR/GI rows with a chassis and a date');
      const doc = { at: now.toISOString(), count: rows.size, grRows: gr, fgRows: fg, giRows: gi, source: clean(upload.source || 'SAP HANA'), rows: encodeSap(rows) };
      await firebase.put(path, doc);
      cache = { rows, at: doc.at, count: rows.size, error: '' }; loadedAt = Date.now();
      return { at: doc.at, chassis: rows.size, gr, fg, gi };
    },
  };
}
