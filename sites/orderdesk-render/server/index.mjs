import { serve } from '@hono/node-server';
import { createFirebase } from './firebase.mjs';
import { createStore } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createApp } from './app.mjs';

const env = process.env;
const firebase = createFirebase(env);
const store = createStore(firebase, { root: env.FIREBASE_ROOT || 'orderdesk/v2' });
const auth = createAuth(env);
const app = createApp({ store, auth, env });
const port = Number(env.PORT) || 3000;

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`Orderdesk listening on :${port} · Firebase ${firebase.url} (${firebase.kind}) · root ${store.info().root}`);
  if (firebase.kind === 'unauthenticated') console.warn('WARNING: no FIREBASE_SERVICE_ACCOUNT / FIREBASE_DATABASE_SECRET set; database rules must allow public access, which is unsafe for production.');
  if (!auth.enabled) console.warn('WARNING: APP_PASSWORD not set; sign-in is disabled (local development only).');
});

// Warm the cache so the first visitor does not wait for the full download.
store.readState().then(({ state }) => console.log(state ? `Loaded ${Object.keys(state.orders || {}).length} orders` : 'Database is empty: import the initial orders first'), e => console.error('Initial Firebase read failed:', e.message));

// Microsoft Graph mode only (the Planning PC mode is driven by the PC's own 00:20 task).
// Replaces the Cloudflare Cron Trigger of the old deployment.
if (env.MAIL_SYNC_MODE === 'graph' && env.MAIL_SYNC_ENABLED === 'true') {
  const minutes = Math.max(5, Number(env.MAIL_SYNC_INTERVAL_MINUTES) || 15);
  setInterval(() => app.runMailSync(false, 'scheduled').catch(e => console.error('Scheduled mail sync failed:', e.message)), minutes * 60000).unref();
  console.log(`Graph mail sync scheduled every ${minutes} minutes`);
}
