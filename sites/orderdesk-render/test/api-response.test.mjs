import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiResponse } from '../lib/api-response.mjs';

test('API reader preserves success and business errors', async () => {
  assert.deepEqual(await readApiResponse(Response.json({ jobId: 'job' }, { status: 202 })), { jobId: 'job' });
  assert.deepEqual(await readApiResponse(Response.json({ error: 'Changed inputs' }, { status: 409 })), { error: 'Changed inputs' });
});
test('HTML proxy failures give status and prevent blind resubmission', async () => {
  await assert.rejects(readApiResponse(new Response('<!DOCTYPE html><title>Gateway timeout</title>', { status: 504 })), error => /HTTP 504/.test(error.message) && /请勿重复提交/.test(error.message) && !/Unexpected token|DOCTYPE/.test(error.message));
});
test('expired API sessions and login redirects explain sign-in', async () => {
  await assert.rejects(readApiResponse(Response.json({ error: 'Unauthorized' }, { status: 401 })), /Session expired/);
  await assert.rejects(readApiResponse({ status: 200, redirected: true, url: 'https:\/\/example.com/login?return_to=/', text: async () => '<!DOCTYPE html>' }), /Session expired/);
});
