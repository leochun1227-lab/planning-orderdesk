// Container / vessel / ETA per chassis from the Dealer Portal "Vessel movements & ETA" data
// (Portal Firebase node tmssystem, read-only). Same rule as the Portal page: only containers whose
// vessel/voyage is in the movement table count; a chassis in several containers keeps the newest.
import { normalizeChassis } from './order-engine.mjs';

const voyageKey = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const text = v => String(v ?? '').trim();
/** dd/mm/yyyy anywhere in the text → yyyy-mm-dd. */
export function tmsDate(value) {
  const m = text(value).match(/(?:^|\D)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/);
  if (!m) return '';
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : '';
}
const arrived = s => { const v = text(s).toLowerCase(); return !v.includes('not arrived') && !v.includes('not yet arrived') && (v.includes('arrived') || v.includes('received') || v.includes('已到')); };

export function parseTms(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object') return out;
  const vessels = new Map(Object.values(raw.vessels || {}).filter(v => v && typeof v === 'object').map(v => [voyageKey(v.vesselVoyage), v]));
  for (const [key, c] of Object.entries(raw.containers || {})) {
    if (!c || typeof c !== 'object') continue;
    const v = vessels.get(voyageKey(c.vesselVoyage));
    if (!v) continue;
    const info = {
      container: text(c.containerNumber) || key, voyage: text(v.vesselVoyage), vesselStatus: text(v.status), arrived: arrived(v.status),
      shippingDate: tmsDate(v.shippingDate), shippingText: text(v.shippingDate), eta: tmsDate(v.etaArrivalMelbourne), etaText: text(v.etaArrivalMelbourne),
      confidence: text(v.confidence), classification: text(v.classification), containerGr: tmsDate(c.sap?.grDate3111), containerStatus: text(c.status),
    };
    for (const ch of c.chassisNumbers || []) {
      const id = normalizeChassis(ch); if (!id) continue;
      const old = out.get(id);
      if (!old || (info.shippingDate || '') > (old.shippingDate || '')) out.set(id, info);
    }
  }
  return out;
}
