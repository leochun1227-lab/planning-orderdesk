import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTms, tmsDate } from '../lib/tms-shipping.mjs';
test('container / vessel / ETA per chassis, movement table only, newest wins', () => {
  const raw = {
    vessels: { a: { vesselVoyage: 'OOCL CANADA V.125S', status: 'In transit', etaArrivalMelbourne: 'ETA 30/11/2026', shippingDate: '', confidence: 'Medium' },
      b: { vesselVoyage: 'ANL GIPPSLAND V.093S', status: 'Arrived', etaArrivalMelbourne: 'Arrived', shippingDate: '18/09/2026' } },
    containers: { c1: { containerNumber: 'TIIU1', vesselVoyage: 'OOCL  Canada V.125S', chassisNumbers: ['SRT-1'] },
      c2: { containerNumber: 'OOLU2', vesselVoyage: 'ANL GIPPSLAND V.093S', chassisNumbers: ['SRT2'], sap: { grDate3111: '14/10/2026' } },
      c3: { containerNumber: 'OLD', vesselVoyage: 'GONE V.1', chassisNumbers: ['SRT2'] } },
  };
  const m = parseTms(raw);
  assert.equal(m.get('SRT1').eta, '2026-11-30'); assert.equal(m.get('SRT1').container, 'TIIU1');
  assert.equal(m.get('SRT2').container, 'OOLU2'); assert.equal(m.get('SRT2').arrived, true); assert.equal(m.get('SRT2').containerGr, '2026-10-14');
  assert.equal(tmsDate('Historical schedule 03/11/2026; completion unverified'), '2026-11-03');
  assert.equal(tmsDate('late to 31/02/2026'), '');
});
