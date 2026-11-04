import test from 'node:test';
import assert from 'node:assert/strict';
import { authConfigured, createSession, verifySession, passwordMatches, safeReturnTo, isSameOrigin,
  handleLogin, handleLogout, createLoginLimiter, SESSION_SECONDS } from '../lib/auth-session.mjs';

const env = { ORDERDESK_LOGIN_PASSWORD: 'test-only-team-password', ORDERDESK_SESSION_SECRET: 'test-only-session-secret-'.repeat(3),
  RENDER_EXTERNAL_URL: 'https://orderdesk.example', RENDER: 'true' };
const login = (password = env.ORDERDESK_LOGIN_PASSWORD, extra = {}) => new Request('http://localhost:10000/api/auth/login', {
  method: 'POST', headers: { origin: env.RENDER_EXTERNAL_URL, 'content-type': 'application/x-www-form-urlencoded', ...extra },
  body: new URLSearchParams({ password, returnTo: '/' }),
});

test('login fails closed without strong credentials and compares passwords exactly', () => {
  assert.equal(authConfigured({}), false);
  assert.equal(authConfigured({ ...env, ORDERDESK_LOGIN_PASSWORD: 'x'.repeat(513) }), false);
  assert.equal(passwordMatches(env.ORDERDESK_LOGIN_PASSWORD, {}), false);
  assert.equal(passwordMatches(env.ORDERDESK_LOGIN_PASSWORD, env), true);
  assert.equal(passwordMatches('wrong-password', env), false);
  assert.equal(passwordMatches(env.ORDERDESK_LOGIN_PASSWORD + ' ', env), false);
});
test('sessions reject forgery, expiry, malformed tokens and credential rotation', () => {
  const now = Date.now(), token = createSession(env, now);
  assert.equal(verifySession(token, env, now).userId, 'planning-team');
  assert.equal(verifySession(token + 'x', env, now), null);
  assert.equal(verifySession(token, env, now + SESSION_SECONDS * 1000), null);
  assert.equal(verifySession('not-a-session', env, now), null);
  assert.equal(verifySession(token, { ...env, ORDERDESK_SESSION_SECRET: 'different-secret-'.repeat(3) }, now), null);
  assert.equal(verifySession(token, { ...env, ORDERDESK_LOGIN_PASSWORD: 'different-password' }, now), null);
  const [payload, signature] = token.split('.');
  const modified = JSON.parse(Buffer.from(payload, 'base64url'));
  modified.exp += 3600;
  assert.equal(verifySession(Buffer.from(JSON.stringify(modified)).toString('base64url') + '.' + signature, env, now), null);
});
test('return URLs cannot redirect to another website or loop back to login', () => {
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/login', '/api/auth/login', '/\n/evil.example', undefined]) {
    assert.equal(safeReturnTo(value), '/');
  }
  assert.equal(safeReturnTo('/compare?view=orders'), '/compare?view=orders');
});
test('CSRF uses the configured public HTTPS origin behind the Render HTTP proxy', () => {
  assert.equal(isSameOrigin(login(), env), true);
  assert.equal(isSameOrigin(login('anything', { origin: 'https://evil.example' }), env), false);
  assert.equal(isSameOrigin(new Request('http://localhost:10000/api/import'), env), false);
  assert.equal(isSameOrigin(login(), { ...env, APP_ORIGIN: 'https://custom.example' }), false);
});
test('login issues a private Secure HttpOnly session; password is never reflected', async () => {
  const response = await handleLogin(login(), env, () => true);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const cookie = response.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_SECONDS}`]) assert.ok(cookie.includes(part));
  assert.ok(!cookie.includes(env.ORDERDESK_LOGIN_PASSWORD));
  assert.ok(verifySession(cookie.split(';')[0].slice('orderdesk_session='.length), env));
  assert.match(response.headers.get('cache-control'), /no-store/);
});
test('wrong password, cross-site login, missing secrets and oversized forms never issue sessions', async () => {
  const wrong = await handleLogin(login('incorrect'), env, () => true);
  assert.equal(wrong.status, 303); assert.match(wrong.headers.get('location'), /error=invalid/);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.equal((await handleLogin(login('anything', { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await handleLogin(login(), { RENDER_EXTERNAL_URL: env.RENDER_EXTERNAL_URL })).status, 503);
  assert.equal((await handleLogin(login('a'.repeat(5000)), env, () => true)).status, 400);
});
test('rate limiting is bounded and recovers after its window', async () => {
  const allow = createLoginLimiter(2, 1000);
  assert.equal(allow(100), true); assert.equal(allow(101), true); assert.equal(allow(102), false);
  assert.equal(allow(1100), true);
  assert.equal((await handleLogin(login(), env, () => false)).status, 429);
});
test('logout requires same-origin POST handling and expires the cookie', () => {
  const response = handleLogout(login(), env);
  assert.equal(response.status, 303);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.match(response.headers.get('set-cookie'), /Secure/);
  assert.equal(handleLogout(login('anything', { origin: 'https://evil.example' }), env).status, 403);
});
