import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isMcpPath, oauthRoute, tokenActor } from "./oauth";
import { json, type McpEnv } from "./security";
import { buildMcpServer, type Dispatch } from "./tools";

export async function handleMcp(
  request: Request,
  env: McpEnv,
  dispatch: Dispatch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isMcpPath(url.pathname)) return null;
  if (!env.MCP_ORIGIN || !env.JWT_SECRET)
    return json({ error: "MCP is not configured." }, 503);
  if (url.origin !== env.MCP_ORIGIN)
    return json({ error: "Invalid host." }, 403);
  const origin = request.headers.get("Origin");
  // The authorization page is a browser navigation from an external OAuth
  // client. Its GET may carry a foreign or opaque Origin. Consent POSTs still
  // require the CMS origin and CSRF token; MCP requests keep origin validation.
  const authorizationNavigation =
    request.method === "GET" && url.pathname === "/oauth/mcp/authorize";
  if (!authorizationNavigation && origin && origin !== env.MCP_ORIGIN && origin !== "https://chatgpt.com")
    return json({ error: "Invalid origin." }, 403);
  try {
    if (
      env.MCP_RATE_LIMITER &&
      !(
        await env.MCP_RATE_LIMITER.limit({
          key: request.headers.get("CF-Connecting-IP") ?? "unknown",
        })
      ).success
    )
      return json({ error: "Too many requests." }, 429, {
        "Retry-After": "60",
      });
    if (url.pathname !== "/mcp") return await oauthRoute(request, env);
    const auth = await tokenActor(request, env);
    if (!auth)
      return json({ error: "Sign in to the Pack 170 CMS." }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${env.MCP_ORIGIN}/.well-known/oauth-protected-resource", scope="cms:read cms:write cms:send"`,
      });
    if (request.method !== "POST")
      return json(
        { error: "This stateless MCP endpoint accepts POST requests." },
        405,
        { Allow: "POST" },
      );
    // No shared server state: each invocation binds exactly one grant and actor.
    const server = buildMcpServer(env, auth.actor, auth.grant, dispatch);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: 64 * 1024,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } finally {
      await server.close();
    }
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === "Request too large")
    )
      return json({ error: "Invalid or oversized request." }, 400);
    console.error(
      JSON.stringify({ event: "mcp_request_failed", path: url.pathname }),
    );
    return json(
      {
        error:
          "MCP temporarily unavailable. Check CMS state before retrying a write.",
      },
      503,
    );
  }
}
