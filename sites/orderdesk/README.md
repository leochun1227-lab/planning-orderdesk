# Regent RV Orderdesk — Render deployment

Next.js website for the Planning team. Windows Task Scheduler collects the Outlook Excel report and uploads it to the website; Firebase holds the existing encrypted order state. Render does not fetch desktop Outlook mail.

## Update the existing Render service

Commit and push these changes. Use the existing Render service with these settings:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Root Directory | `sites/orderdesk` |
| Runtime | Node |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

The build now uses `next build`. Startup validates required credentials, then runs Next.js on `0.0.0.0` and Render's `PORT`. The old `wrangler dev` command is no longer used. Do not use the Vite/Sites build helpers for Render.

Set these **server-side** variables in Render Environment before deploying:

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `24.18.0` (locally verified; the package supports Node 24) |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `ORDERDESK_KEY` | **The existing** 64-character hexadecimal Firebase encryption key. A new random key cannot decrypt existing orders. |
| `ORDERDESK_LOGIN_PASSWORD` | A strong team password, 12–512 characters; generate with a password manager. |
| `ORDERDESK_SESSION_SECRET` | A separate random secret, at least 32 characters. Keep it stable across deployments. |
| `MAIL_SYNC_MODE` | `planning-pc` |
| `PLANNING_AGENT_TOKEN` | Separate random upload credential, at least 32 characters; use the same value on the Planning computer. |
| `PLANNING_AGENT_ENABLED` | `false` initially; change to `true` after computer verification succeeds. |

Do not use `NEXT_PUBLIC_` prefixes for these variables. Do not commit secrets or paste them into chat.
Generate each new secret independently with a password manager or this local command:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use generated values only for **new login/session/upload credentials**, never to replace `ORDERDESK_KEY`. Retain an existing Planning-agent token or update both ends together.

Render supplies `RENDER_EXTERNAL_URL` automatically. The app uses it for browser POST origin validation behind the HTTPS proxy. For a custom domain, set `APP_ORIGIN=https://your-domain.example` to the exact public origin, with no path. Use that one origin for login and browser operations.

`ORDERDESK_DATABASE_URL` is optional. Leave it unset to retain the existing Firebase endpoint. It supports a separate test database; code deployment does not copy local test orders into Firebase. Preserve database access rules and the encryption key; do not loosen rules to resolve deployment errors.

For a **new** Render Blueprint, the repository-root `render.yaml` supplies settings and generates session/upload secrets. An existing manually created service does not automatically read that file: update its Settings and Environment explicitly. You do not need a second service.

References: [Next.js on Render](https://render.com/docs/deploy-nextjs-app), [Node versions](https://render.com/docs/node-version), [port binding](https://render.com/docs/web-services#port-binding).

## Login and access

The website uses a shared Planning-team password and a signed 12-hour HttpOnly, SameSite cookie (Secure on Render). It does not trust `oai-authenticated-user-*` headers or require ChatGPT sign-in. All order read/write/export endpoints verify the session; browser POSTs require the configured origin.

Login is limited to 30 attempts per minute across one server process. Changing the team password or session secret invalidates existing sessions. Sign out clears the browser cookie. This is shared-team access, not individual accounts or per-user audit attribution. Before horizontal scaling, use a shared rate limiter or identity provider.

`/api/planning-agent` uses only its separate bearer token. A browser session cannot authorize uploads, and the upload token cannot access browser order endpoints. `/api/health` exposes only liveness; it does not verify the Firebase key.

## Verify deployment

1. Deploy the pushed commit. Logs should show Next.js listening on `0.0.0.0` and Render's port, followed by a healthy service, with no Wrangler launch.
2. Open the HTTPS URL and sign in using the team password.
3. Check expected orders, latest report date, history and an Orderlist export before enabling imports. If decryption fails, restore the correct `ORDERDESK_KEY`; do not reset the database.
4. Follow `planning-pc/README.txt`. Configure the computer with the Render URL and upload token, without `-PrivateSites`. Run `Run-Agent.ps1 -VerifyOnly` against a real fresh report.
5. Set `PLANNING_AGENT_ENABLED=true` and verify an actual scheduled upload.

The task runs daily at **00:20 Australia/Sydney**, using classic Outlook under the signed-in Windows user. It accepts only mail received in the preceding 30 minutes and does not catch up missed runs. Keep the computer on, online and signed in for the run. The website runs independently of that computer.

Render Free services can sleep and require cold starts; use an always-on service for reliable time-sensitive uploads. See [Render Free limitations](https://render.com/docs/free).

## Local development and checks

Use Node 24 and `npm ci --include=dev`. Supply credentials through environment variables or ignored `.env.local` for `npm run dev`. Use `APP_ORIGIN=http://localhost:3000` for local browser POSTs. `npm start` expects environment variables to already be set, as Render does.

```sh
npm test
npm run build
node scripts/render-smoke.mjs
```

The smoke test starts the **built production server** with random credentials and a local in-memory Firebase-compatible fixture. It checks health, login, forged-header rejection, CSRF, orders, manual import, XLSX export, Planning-agent verification/upload/deduplication and logout. It never accesses production Firebase.

Original Vite/Cloudflare scaffolding remains for source history and existing business tests, but is not part of the Render launch path. Use the npm commands above for this deployment.

## Preserved business behavior

`/api/export` retains the exact 20-column Orderlist layout, styles, column widths, date formats, panes, print settings and conditional formats. Exports follow current grid selection/order; history exports remain logs. Per-chassis auxiliary values/styles live in `state.orderlistExport` and must be preserved with the database. Website business fields take precedence over original auxiliary values. Exports contain no source macros or external-workbook formulas.

CRM imports retain dealer/customer classification, milestone dates, request-date rules, completed/cancelled status protection, report deduplication and Firebase ETag conflict checks. Microsoft Graph code remains inactive in `planning-pc` mode and is not scheduled by Render; this deployment uses the Windows task.
