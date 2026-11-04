import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'orderdesk_session';
export const SESSION_SECONDS = 12 * 60 * 60;
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));

export function authConfigured(env = process.env) {
  return typeof env.ORDERDESK_LOGIN_PASSWORD === 'string' && env.ORDERDESK_LOGIN_PASSWORD.length >= 12 && env.ORDERDESK_LOGIN_PASSWORD.length <= 512
    && typeof env.ORDERDESK_SESSION_SECRET === 'string' && env.ORDERDESK_SESSION_SECRET.length >= 32;
}

export function passwordMatches(password, env = process.env) {
  return authConfigured(env) && typeof password === 'string' && password.length <= 512
    && equal(password, env.ORDERDESK_LOGIN_PASSWORD);
}

function signingKey(env) {
  // Changing either credential invalidates all existing sessions.
  return createHmac('sha256', env.ORDERDESK_SESSION_SECRET).update(env.ORDERDESK_LOGIN_PASSWORD).digest();
}

export function createSession(env = process.env, now = Date.now()) {
  if (!authConfigured(env)) throw new Error('Website login is not configured');
  const payload = Buffer.from(JSON.stringify({ sub: 'planning-team', exp: Math.floor(now / 1000) + SESSION_SECONDS,
    nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return payload + '.' + createHmac('sha256', signingKey(env)).update(payload).digest('base64url');
}

export function verifySession(token, env = process.env, now = Date.now()) {
  if (!authConfigured(env) || typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = createHmac('sha256', signingKey(env)).update(payload).digest('base64url');
  if (!equal(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (data.sub !== 'planning-team' || !Number.isSafeInteger(data.exp) || data.exp <= seconds
      || data.exp > seconds + SESSION_SECONDS) return null;
    return { userId: 'planning-team', displayName: 'Planning Team' };
  } catch { return null; }
}

export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://orderdesk.invalid');
    if (url.origin !== 'https://orderdesk.invalid' || /^\/(login|api\/auth)(\/|$)/.test(url.pathname)) return '/';
    return url.pathname + url.search;
  } catch { return '/'; }
}

export function websiteOrigin(request, env = process.env) {
  return new URL(env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || request.url).origin;
}

export function isSameOrigin(request, env = process.env) {
  try { return request.headers.get('origin') === websiteOrigin(request, env); }
  catch { return false; }
}

export function sessionCookie(token, request, env = process.env, maxAge = SESSION_SECONDS) {
  const secure = env.RENDER === 'true' || websiteOrigin(request, env).startsWith('https:');
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// A process-wide ceiling cannot be evaded by spoofing forwarded IP headers.
// This app runs as a single Render instance; distributed rate limiting is needed before scaling it.
export function createLoginLimiter(limit = 30, windowMs = 60_000) {
  let count = 0, resetAt = 0;
  return (now = Date.now()) => {
    if (now >= resetAt) { count = 0; resetAt = now + windowMs; }
    return ++count <= limit;
  };
}
const allowLogin = createLoginLimiter();

async function boundedLoginBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Error('form');
  if (Number(request.headers.get('content-length')) > 4096) throw new Error('size');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error('size');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function handleLogin(request, env = process.env, allow = allowLogin) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!isSameOrigin(request, env)) return new Response('Invalid request origin', { status: 403, headers });
  if (!authConfigured(env)) return new Response('Website login is not configured', { status: 503, headers });
  if (!allow()) return new Response('Too many attempts. Please wait one minute.', { status: 429, headers: { ...headers, 'Retry-After': '60' } });
  let form;
  try { form = new URLSearchParams(await boundedLoginBody(request)); }
  catch { return new Response('Invalid login form', { status: 400, headers }); }
  const returnTo = safeReturnTo(form.get('returnTo'));
  if (!passwordMatches(form.get('password'), env)) {
    return new Response(null, { status: 303, headers: { ...headers, Location: '/login?error=invalid&returnTo=' + encodeURIComponent(returnTo) } });
  }
  return new Response(null, { status: 303, headers: { ...headers, Location: returnTo,
    'Set-Cookie': sessionCookie(createSession(env), request, env) } });
}

export function handleLogout(request, env = process.env) {
  if (!isSameOrigin(request, env)) return new Response('Invalid request origin', { status: 403 });
  return new Response(null, { status: 303, headers: { Location: '/login', 'Cache-Control': 'private, no-store',
    'Set-Cookie': sessionCookie('', request, env, 0) } });
}
