import handler from "vinext/server/fetch-handler";
import { withRuntime } from "../lib/runtime";
import { runConfiguredMailSync } from "../lib/mail-sync-runtime";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

const worker = {
  // Invoked by a cloud Cron Trigger after deployment and Microsoft authorization.
  // No browser session or desktop Outlook process is needed.
  scheduled(_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    const values=env as unknown as Record<string,unknown>;
    if(values.MAIL_SYNC_MODE!=='graph'||values.MAIL_SYNC_ENABLED!=='true')return;
    ctx.waitUntil(Promise.resolve(withRuntime(values,()=>runConfiguredMailSync(false,'scheduled'))));
  },
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return withRuntime(env as unknown as Record<string,unknown>, () => runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx)));
  },
};

export default worker;
