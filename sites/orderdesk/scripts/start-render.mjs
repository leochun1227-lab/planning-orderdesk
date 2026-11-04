import { fileURLToPath } from 'node:url';
import { authConfigured } from '../lib/auth-session.mjs';

if (!authConfigured()) {
  console.error('Set ORDERDESK_LOGIN_PASSWORD (12-512 characters) and ORDERDESK_SESSION_SECRET (32+ random characters) in Render Environment.');
  process.exit(1);
}
if (!/^[a-f0-9]{64}$/i.test(process.env.ORDERDESK_KEY || '')) {
  console.error('Set ORDERDESK_KEY to the existing 64-character hexadecimal Firebase encryption key. Do not generate a replacement key.');
  process.exit(1);
}
const origin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;
if (origin) {
  const url = new URL(origin);
  const local = !process.env.RENDER && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_ORIGIN must be the HTTPS website origin, with no path or credentials.');
  }
}
const cli = new URL('../node_modules/next/dist/bin/next', import.meta.url);
process.env.NODE_ENV = 'production';
// Next reads PORT from the environment; no shell-specific $PORT syntax is needed.
process.argv = [process.execPath, fileURLToPath(cli), 'start', '--hostname', '0.0.0.0'];
await import(cli.href);
