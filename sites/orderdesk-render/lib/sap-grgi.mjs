// SAP GR / GI per chassis, pushed by a computer inside the company network (SAP HANA is not
// reachable from Render). The computer runs the same SQL as the Planning Schedule workbook's
// Power Query "GR" and "PGI" queries and posts {gr: [[chassis, grDate, po, poDate]], gi: [[chassis, giDate, doc]]}.
// This is the only GR / GI source of the production line (no Portal copies).
// Stored compactly at orderdesk/sap-grgi (outside the order state, so order saves never load it).
import { normalizeChassis } from './order-engine.mjs';

export const SAP_PATH = 'orderdesk/sap-grgi';
export const SAP_MAX_BYTES = 20 * 1024 * 1024;
const day = v => { const s = String(v ?? '').trim(); const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/); return m && m[1] > '1971' ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const clean = v => String(v ?? '').replace(/[|\s]+/g, ' ').trim().slice(0, 20);

/**
 * Validate an upload and fold it per chassis. gr rows: [chassis, grDate or '', po, poDate] (a PO without
 * a GR is kept, so "PO raised, not received" differs from "not in SAP"); gi rows: [chassis, giDate, doc].
 * The latest GR and the latest GI win.
 */
export function foldSapUpload(body) {
  if (!body || !Array.isArray(body.gr) || !Array.isArray(body.gi)) throw new Error('gr and gi arrays are required');
  if (body.gr.length + body.gi.length > 300000) throw new Error('too many rows');
  const rows = new Map();
  const row = c => rows.get(c) || rows.set(c, { grAt: '', po: '', poAt: '', giAt: '', giDoc: '' }).get(c);
  let gr = 0, gi = 0;
  for (const r of body.gr) {
    if (!Array.isArray(r)) continue;
    const c = normalizeChassis(r[0]), d = day(r[1]), po = clean(r[2]), poAt = day(r[3]);
    if (!c || !/^[A-Z0-9]{4,20}$/.test(c) || (!d && !po)) continue;
    const x = row(c);
    if (d && d >= x.grAt) { x.grAt = d; x.po = po; x.poAt = poAt; } else if (!x.grAt && po && poAt >= x.poAt) { x.po = po; x.poAt = poAt; }
    if (d) gr++;
  }
  for (const r of body.gi) {
    if (!Array.isArray(r)) continue;
    const c = normalizeChassis(r[0]), d = day(r[1]);
    if (!c || !/^[A-Z0-9]{4,20}$/.test(c) || !d) continue;
    const x = row(c); if (d >= x.giAt) { x.giAt = d; x.giDoc = clean(r[2]); } gi++;
  }
  return { rows, gr, gi };
}
const FIELDS = ['grAt', 'po', 'poAt', 'giAt', 'giDoc'];
export const encodeSap = rows => Object.fromEntries([...rows].map(([c, x]) => [c, FIELDS.map(f => x[f]).join('|')]));
export const decodeSap = obj => new Map(Object.entries(obj || {}).map(([c, s]) => { const v = String(s).split('|'); return [c, Object.fromEntries(FIELDS.map((f, i) => [f, v[i] || '']))]; }));

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
      const { rows, gr, gi } = foldSapUpload(upload);
      if (!rows.size) throw new Error('No GR/GI rows with a chassis and a date');
      const doc = { at: now.toISOString(), count: rows.size, grRows: gr, giRows: gi, source: clean(upload.source || 'SAP HANA'), rows: encodeSap(rows) };
      await firebase.put(path, doc);
      cache = { rows, at: doc.at, count: rows.size, error: '' }; loadedAt = Date.now();
      return { at: doc.at, chassis: rows.size, gr, gi };
    },
  };
}
