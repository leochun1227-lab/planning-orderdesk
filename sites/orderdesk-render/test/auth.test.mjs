import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';

const req = (cookie = '') => new Request('http://x/', { headers: cookie ? { cookie } : {} });

test('sign-in is off by default, even in production with an APP_PASSWORD set', async () => {
  const auth = createAuth({ NODE_ENV: 'production', APP_PASSWORD: 'old-team-password' });
  assert.equal(auth.enabled, false);
  assert.deepEqual(auth.user(req()), { name: 'Planning' });
  const app = createApp({ store: { info: () => ({}) }, auth, env: {} });
  const login = await app.request('/login');
  assert.equal(login.status, 302); assert.equal(login.headers.get('location'), '/');
  const session = await (await app.request('/api/session')).json();
  assert.equal(session.signIn, false); assert.equal(session.user.name, 'Planning');
});

test('REQUIRE_PASSWORD=1 brings the team password back', () => {
  assert.throws(() => createAuth({ REQUIRE_PASSWORD: '1', APP_PASSWORD: 'short' }), /APP_PASSWORD/);
  const auth = createAuth({ REQUIRE_PASSWORD: '1', APP_PASSWORD: 'team-password', SESSION_SECRET: 'x'.repeat(32) });
  assert.equal(auth.enabled, true); assert.equal(auth.user(req()), null);
  assert.equal(auth.checkPassword('team-password'), true); assert.equal(auth.checkPassword('nope'), false);
  const cookie = auth.sessionCookie('Leo', false).split(';')[0];
  assert.deepEqual(auth.user(req(cookie)), { name: 'Leo' });
});
