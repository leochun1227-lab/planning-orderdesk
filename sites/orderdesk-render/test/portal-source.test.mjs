import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalSource } from '../lib/portal-source.mjs';
import { PORTAL_BOARD_SOURCES } from '../lib/campervan-plan.mjs';

test('shared Portal copy: one download per interval, stale copy served while refreshing, failure keeps the copy', async () => {
  let calls = 0, fail = false;
  const fetcher = async () => { calls++; if (fail) throw new Error('down'); return new Response('{"a":1}', { status: 200 }); };
  const src = createPortalSource({ fetcher, ttlMs: 60 * 60 * 1000 });
  const a = await src.current(); assert.equal(calls, PORTAL_BOARD_SOURCES.length); assert.deepEqual(a.raw.datetrack, { a: 1 });
  await src.current(); await src.current(); assert.equal(calls, PORTAL_BOARD_SOURCES.length);
  fail = true; const b = await src.current({ force: true });
  assert.equal(b.error, 'down'); assert.deepEqual(b.raw.datetrack, { a: 1 });
});
