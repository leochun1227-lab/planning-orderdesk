// Team sign-in for Render (replaces the ChatGPT Sites sign-in).
// APP_PASSWORD  shared team password (required in production)
// SESSION_SECRET random string used to sign session cookies
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'od_session';
const DAYS = 30;

export function createAuth(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const password = env.APP_PASSWORD || '';
  if (production && password.length < 8) throw new Error('APP_PASSWORD (at least 8 characters) is required in production');
  if (production && (env.SESSION_SECRET || '').length < 32) throw new Error('SESSION_SECRET (at least 32 characters) is required in production');
  const secret = env.SESSION_SECRET || randomBytes(32).toString('hex');
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

  function readCookie(request) {
    const header = request.headers.get('cookie') || '';
    const match = header.split(/;\s*/).find(p => p.startsWith(COOKIE + '='));
    return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : '';
  }
  function user(request) {
    if (!password) return { name: 'Local' }; // local development without a password
    const [payload, mac] = readCookie(request).split('.');
    if (!payload || !mac || !same(sign(payload), mac)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.exp > Date.now() ? { name: data.name || 'Planning' } : null;
    } catch { return null; }
  }
  function checkPassword(supplied) {
    const a = createHmac('sha256', secret).update(String(supplied ?? '')).digest();
    const b = createHmac('sha256', secret).update(password).digest();
    return !!password && timingSafeEqual(a, b);
  }
  function sessionCookie(name, secure) {
    const payload = Buffer.from(JSON.stringify({ name: String(name || 'Planning').slice(0, 60), exp: Date.now() + DAYS * 86400000 })).toString('base64url');
    return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure ? '; Secure' : ''}`;
  }
  const clearCookie = secure => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  return { user, checkPassword, sessionCookie, clearCookie, enabled: !!password };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function loginPage({ error = '', returnTo = '/' } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Orderdesk</title><link rel="icon" href="/favicon.svg">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;color:#182740}
form{width:min(380px,calc(100vw - 32px));background:#fff;border:1px solid #e1e7ef;border-radius:12px;padding:34px;box-shadow:0 10px 40px #14243b10}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}.mark{font-size:40px;font-weight:850;font-style:italic;color:#14223b;letter-spacing:-6px}.brand small{display:block;font-size:12px;letter-spacing:1.4px;color:#8391a6}.brand strong{font-size:22px}
label{display:block;font-size:14px;color:#53627a;margin:16px 0 7px}input{width:100%;height:43px;border:1px solid #dce4ef;border-radius:7px;padding:0 12px;font:inherit}
button{margin-top:24px;width:100%;height:44px;border:0;border-radius:7px;background:#315fe9;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#224ed4}
.error{margin-top:14px;background:#fff1ed;color:#a54731;border:1px solid #f1ccbf;border-radius:7px;padding:10px 12px;font-size:14px}</style></head>
<body><form method="post" action="/login"><div class="brand"><span class="mark">R</span><div><small>REGENT RV</small><strong>Orderdesk</strong></div></div>
<input type="hidden" name="return_to" value="${esc(returnTo)}">
<label for="name">姓名 / Name</label><input id="name" name="name" autocomplete="name" placeholder="Planning">
<label for="password">团队密码 / Team password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<div class="error">${esc(error)}</div>` : ''}<button type="submit">登录 / Sign in</button></form></body></html>`;
}
