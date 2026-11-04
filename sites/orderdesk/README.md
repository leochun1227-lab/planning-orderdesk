# vinext-starter

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git and `tar` (including Windows `tar.exe`) are required for publishing; portable publication does not require Bash

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Run `node <plugin-root>/scripts/configure-execution-profile.mjs` only when the profile is unknown for the current checkout and environment. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

Publish archives outside the source checkout or under its ignored `outputs/` directory. Local `.env*`, `.dev.vars*`, TypeScript build state, and tool runtime directories are ignored; keep the hosting manifest, migrations, and authored scripts in source control.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For managed Linux browser QA, follow the Sites skill's managed preview reference. The daemon runs the project's Vite dev script with `--host 0.0.0.0 --port 4173 --strictPort`; use the CLI's returned URL. The ignored local profile survives the daemon's cleared environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `worker/index.ts` is the production Worker entrypoint and preserves request-scoped connector bindings
- `scripts/vite/` contains the maintained Vite integrations and the vendored Sites plugin license
- `scripts/connector-preview/` contains the local connector preview Worker and session helpers
- the remaining `scripts/` files select execution profiles and run installation, development, and builds; the plugin's helpers orchestrate the Sites lifecycle
- `dist/` contains generated deployment output; `.vinext/`, `.wrangler/`, and `.sites-runtime/` contain ignored local tool state
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)

## Current choice: Planning computer with classic Outlook

User changed the requested design on 2026-11-04 to a dedicated always-on Windows computer with classic Outlook. `planning-pc/README.txt` is the installation and verification runbook. The server now defaults to `planning-pc` mode; Graph polling requires an explicit `MAIL_SYNC_MODE=graph` and remains inactive otherwise.

`POST /api/planning-agent` accepts bounded XLSX uploads authenticated by a separate server-side `PLANNING_AGENT_TOKEN` (32+ random characters). `PLANNING_AGENT_ENABLED=false` permits plan/verification calls but blocks imports and heartbeat writes. Store neither this token nor a private Sites service-access token in source. The collector only needs the upload credential; it never receives the database encryption key. Use the actual published website with its existing private access boundary; localhost on the Planning computer does not address this developer computer.

The Windows installer uses one interactive-user daily task at 00:20 Australia/Sydney, with no Windows password saved and no SYSTEM service. It checks the computer's Sydney time zone, follows DST, and has no logon, repetition or missed-run catch-up trigger. Both collector and receiver accept only mail received in the preceding 30 minutes (23:50–00:20 at the scheduled run); no matching report produces a missing-report marker and leaves orders unchanged. All Outlook operations occur in a Windows PowerShell STA process with the user's profile. Keep the computer online and the Windows user signed in. The current delivery has not installed a task, configured a target computer, or deployed a production endpoint. Check actual Outlook access, a real fresh attachment, deployed endpoint access, reconciled production data and a real scheduled upload before calling it enabled.

Order exports use `/api/export` and the exact 20-column Orderlist layout extracted from the supplied Planning Schedule (4). Template styles, column widths, header height, date formats, panes, print settings and conditional formats are retained. Export follows the current grid selection/order; change-history export remains a log. Per-chassis presentation and auxiliary source values live in `state.orderlistExport`; migrate this metadata with the reconciled database. Website business fields take precedence; auxiliary values (forecast/shipment/VIN/price/index/ranks/semi estimate) fall back to the matched original snapshot if not maintained in the website. No source worksheet data, macros or external-workbook formulas are bundled into the XLSX export. `lib/orderlist-template.json` contains only layout/styles, headers and conditional-format definitions. The standalone export is a snapshot of website data, not a copy of the original workbook's calculation dependencies.

Tests: `node --test --test-isolation=none scripts/planning-agent.test.mjs` plus existing business-rule and mail-sync tests. The earlier optional Graph implementation below is retained but is not the selected deployment path.

## Optional Graph mailbox automation (inactive)

The server reads `planning@regentrv.com.au` → `CRM Report` using Microsoft Graph client credentials. Desktop Outlook and the Codex Outlook connector are not required. The code accepts only `Sales Order Report (Customer)` from `donotreply@my300375.mail.c4c.saphybriscloud.cn`, with exactly one non-inline `.xlsx` file attachment. Mail and attachment calls use GET only: no send, move, delete or mark-as-read operation is implemented.

Configure these **server-side secrets**, never client variables, source files or chat messages:

| Name | Meaning |
| --- | --- |
| `MS_GRAPH_TENANT_ID` | Microsoft 365 tenant ID |
| `MS_GRAPH_CLIENT_ID` | Application/client ID for this reader |
| `MS_GRAPH_CLIENT_SECRET` | Application secret; monitor expiry and rotate in secret storage |
| `MS_GRAPH_CRM_FOLDER_ID` | Optional; required if multiple folders are named CRM Report |
| `MAIL_SYNC_ENABLED` | Keep `false` for initial verification; `true` permits order updates |
| `ORDERDESK_KEY` | Existing database encryption key; retain the existing key |

The Microsoft administrator must grant this app read access to the Planning mailbox. Prefer Exchange Online Application RBAC with the `Application Mail.Read` role scoped to that mailbox. Do not add a tenant-wide Entra `Mail.Read` grant alongside a scoped RBAC assignment: the grants are additive. `Mail.ReadBasic` cannot read attachments. Mailbox-level authorization and application filtering to the CRM Report folder are separate controls; this implementation does not claim that Microsoft limits the permission to one folder.

References: [client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow), [Exchange Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac), [attachment permissions](https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0).

Activation sequence:

1. Configure the cloud runtime credentials. Keep the website private and retain existing authenticated access. An existing Outlook desktop login is not this application's authorization.
2. Deploy the reconciled website version and current authoritative data together; current local test data is not automatically copied to the hosted database by a code deployment. Back up and compare the hosted database before migration. Production database access must be appropriately restricted.
3. In Connections, click **Test report access**. `POST /api/mail-sync` with `{ "action": "verify" }` reads actual mail/attachments and calculates the existing order-engine result without writing orders, checkpoints or success markers. Inspect the target mailbox and expected report date/row count. A local comparison preview intentionally remains disconnected from live mail.
4. After a successful read test, enable `MAIL_SYNC_ENABLED=true`. **Check and import** invokes the same code as the background job. Verify the saved result by re-reading orders/import history.
5. Configure an actual cloud scheduler targeting the Worker's `scheduled` handler (suggested initial cadence: every 30 minutes, `*/30 * * * *`, UTC). The handler alone does not create a schedule. The Sites manifest currently has no declared Cron Trigger; confirm hosting support before enabling, or run the same sync module in a separately managed cloud worker with authorized database access. Do not substitute a local timer or the browser being open.
6. Exercise the deployed scheduled handler and verify `meta.mailSync.lastScheduledSuccessAt` and the saved order result. The page must remain in **Awaiting first scheduled run** until a scheduled invocation succeeds. No cloud schedule, Microsoft credentials, or cloud integration test was completed in this implementation pass.

The import uses the same `reportFingerprint` and `applyReport` as manual CRM upload. It preserves existing Dealer and milestone dates, protects concrete Request dates from ASAP/blank, and applies Customer/production/cancellation rules. Already manually imported reports are duplicates even if re-delivered in another email. Reports are sorted by report date; dates older than the last import are skipped and future/unrecognizable dates stop the run. Do not substitute message arrival date for report date. Processing dates follow the existing Australia/Sydney run-day rule.

Mail checkpoints and order changes commit together using the Firebase ETag; a concurrent update wins without being overwritten. A malformed attachment aborts the run without partial order changes. Failures persist a sanitized error and leave the previous successful checkpoint intact. Rate limits retry on the next scheduled run. Each run scans from two days before the last imported report and stops explicitly if its bounded page/report limits are exceeded. Successful message IDs are hashed; no access token, email body or attachment bytes are saved. Report summaries appear in import history; latest check/error information is shown on Connections.

Verification commands:

```sh
node --test --test-isolation=none scripts/mail-sync.test.mjs scripts/order-engine.test.mjs scripts/milestone-import.test.mjs scripts/production-rules.test.mjs scripts/production-status.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
```
