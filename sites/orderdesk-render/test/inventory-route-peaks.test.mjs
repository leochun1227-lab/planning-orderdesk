import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRoutePeaks } from '../lib/inventory-route-peaks.mjs';

test('linear route peaks match a full future replay for fractional sales, depletion and later fixed overflows', () => {
  let seed = 1843;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let sample = 0; sample < 80; sample++) {
    const n = 80, cap = Math.floor(random() * 25), demand = random() * 3, balance = [], missed = [];
    let stock = random() * 20;
    for (let i = 0; i < n; i++) {
      stock += random() < .13 ? Math.floor(random() * 20) : 0;
      const sold = Math.min(stock, demand); stock -= sold; balance.push(stock); missed.push(demand - sold);
    }
    const result = inventoryRoutePeaks(balance, missed, cap);
    for (let t = 0; t < n; t++) {
      let peak = 0, pressure = 0, consumed = 0;
      for (let i = t; i < n; i++) {
        consumed += missed[i]; const extra = Math.max(0, 1 - consumed);
        peak = Math.max(peak, balance[i] + extra);
        if (extra > 1e-8) pressure = Math.max(pressure, balance[i] + extra - cap);
      }
      assert.ok(Math.abs(result.over[t] - Math.max(0, peak - cap)) < 1e-7);
      assert.ok(Math.abs(result.ownOver[t] - pressure) < 1e-7);
    }
  }
});

test('a unit consumed before an unrelated later ceiling conflict does not justify changing its dealer', () => {
  const result = inventoryRoutePeaks([0, 0, 0, 15], [1, 1, 1, 0], 10);
  assert.equal(result.ownOver[0], 0); assert.equal(result.over[0], 5);
  assert.equal(result.ownOver[3], 6); assert.equal(result.over[3], 6);
});
