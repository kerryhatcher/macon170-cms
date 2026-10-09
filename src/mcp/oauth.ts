import {
  activeActor,
  browserActor,
  csrfForm,
  encode,
  escapeHtml as esc,
  hash,
  json,
  page,
  random,
  scopes,
  smallBody,
  type Actor,
  type McpEnv,
} from "./security";

type Client = { redirect_uris: string[]; client_name: string };
export type Grant = {
  id: string;
  user_id: string;
  client_id: string;
  resource: string;
  scope: string;
  expires_at: number;
};
const clientPrefix = "pack170-client.";
async function clientKey(env: McpEnv) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function signClient(env: McpEnv, client: Client): Promise<string> {
  const data = encode(
    new TextEncoder().encode(JSON.stringify({ ...client, nonce: random() })),
  );
  const message = clientPrefix + data;
  return (
    message +
    "." +
    encode(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await clientKey(env),
          new TextEncoder().encode(message),
        ),
      ),
    )
  );
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (x) => x.charCodeAt(0),
  );
}
async function readClient(env: McpEnv, id: string): Promise<Client | null> {
  if (!id.startsWith(clientPrefix) || id.length > 12000) return null;
  try {
    const parts = id.split(".");
    if (
      parts.length !== 3 ||
      !(await crypto.subtle.verify(
        "HMAC",
        await clientKey(env),
        decode(parts[2]!),
        new TextEncoder().encode(parts.slice(0, 2).join(".")),
      ))
    )
      return null;
    return JSON.parse(new TextDecoder().decode(decode(parts[1]!))) as Client;
  } catch {
    return null;
  }
}
function validRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    const secure = u.protocol === "https:";
    // RFC 8252 native applications receive OAuth callbacks on a loopback port.
    const loopback =
      u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname);
    return (secure || loopback) && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}
const oauthError = (message: string, status = 400) =>
  json({ error: "invalid_request", error_description: message }, status);
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
export function isMcpPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path.startsWith("/oauth/mcp/") ||
    path === "/admin/chatgpt" ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp"
  );
}
export async function oauthRoute(
  request: Request,
  env: McpEnv,
): Promise<Response> {
  const url = new URL(request.url),
    origin = env.MCP_ORIGIN,
    resource = origin + "/mcp";
  if (
    request.method === "GET" &&
    url.pathname.startsWith("/.well-known/oauth-protected-resource")
  )
    return json({
      resource,
      authorization_servers: [origin],
      scopes_supported: scopes,
      bearer_methods_supported: ["header"],
    });
  if (
    request.method === "GET" &&
    url.pathname === "/.well-known/oauth-authorization-server"
  )
    return json({
      issuer: origin,
      authorization_endpoint: origin + "/oauth/mcp/authorize",
      token_endpoint: origin + "/oauth/mcp/token",
      registration_endpoint: origin + "/oauth/mcp/register",
      revocation_endpoint: origin + "/oauth/mcp/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: scopes,
      authorization_response_iss_parameter_supported: true,
    });
  if (request.method === "POST" && url.pathname === "/oauth/mcp/register") {
    const body = JSON.parse(await smallBody(request)) as Record<
      string,
      unknown
    >;
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length < 1 ||
      body.redirect_uris.length > 5 ||
      !body.redirect_uris.every(validRedirect) ||
      JSON.stringify(body.redirect_uris).length > 4096 ||
      (body.token_endpoint_auth_method &&
        body.token_endpoint_auth_method !== "none")
    )
      return oauthError(
        "HTTPS or native loopback redirect URIs and public clients are required.",
      );
    const client: Client = {
      redirect_uris: body.redirect_uris,
      client_name:
        typeof body.client_name === "string"
          ? body.client_name.slice(0, 120)
          : "MCP client",
    };
    return json(
      {
        ...client,
        client_id: await signClient(env, client),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }
  if (
    url.pathname === "/oauth/mcp/authorize" &&
    ["GET", "POST"].includes(request.method)
  ) {
    const params =
      request.method === "POST"
        ? new URLSearchParams(await smallBody(request))
        : url.searchParams;
    const clientId = params.get("client_id") ?? "",
      client = await readClient(env, clientId);
    const redirect = params.get("redirect_uri") ?? "",
      challenge = params.get("code_challenge") ?? "",
      state = params.get("state") ?? "";
    const requested = (params.get("scope") || "cms:read")
      .split(" ")
      .filter(Boolean);
    if (
      !client ||
      !client.redirect_uris.includes(redirect) ||
      params.get("resource") !== resource ||
      params.get("response_type") !== "code" ||
      params.get("code_challenge_method") !== "S256" ||
      !/^[\w-]{43}$/.test(challenge) ||
      state.length > 2048 ||
      requested.some((s) => !scopes.includes(s as (typeof scopes)[number]))
    )
      return oauthError(
        "Invalid OAuth request, scope, resource, redirect URI or PKCE challenge.",
      );
    const actor = await browserActor(request, env);
    if (!actor) {
      if (request.method === "POST")
        return oauthError("Sign in as an active CMS administrator.", 401);
      return Response.redirect(
        origin +
          "/auth/login?returnTo=" +
          encodeURIComponent(url.pathname + url.search),
        302,
      );
    }
    if (request.method === "GET")
      return page(
        env,
        "Connect Pack 170 to ChatGPT",
        (csrf) =>
          `<p>Signed in as ${esc(actor.email)}.</p><p>Client: <strong>${esc(client.client_name)}</strong><br>Return address: ${esc(new URL(redirect).origin)}</p><p>This connection can access private Pack data with your administrator permissions. It expires in 30 days and can be revoked at any time.</p><form method="post">${[
            ...params,
          ]
            .filter(([key]) => key !== "csrf_token")
            .map(([key, value]) => hidden(key, value))
            .join(
              "",
            )}${hidden("csrf_token", csrf)}<ul>${requested.map((s) => `<li>${esc({ "cms:read": "Read calendar, leadership, inquiries, signup responses, mailing lists and invitations.", "cms:write": "Create, edit, publish and delete Pack records and change list memberships.", "cms:send": "Queue email broadcasts and send or resend volunteer and signup emails." }[s]!)}</li>`).join("")}</ul><button name="decision" value="allow">Allow connection</button> <button name="decision" value="deny">Cancel</button></form>`,
      );
    if (!(await csrfForm(request, env, params)))
      return oauthError("Security token rejected.", 403);
    const destination = new URL(redirect);
    destination.searchParams.set("state", state);
    destination.searchParams.set("iss", origin);
    if (params.get("decision") !== "allow")
      destination.searchParams.set("error", "access_denied");
    else {
      const grant = crypto.randomUUID(),
        code = random(),
        now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO mcp_grants(id,user_id,client_id,client_name,resource,scope,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(
          grant,
          actor.id,
          clientId,
          client.client_name,
          resource,
          requested.join(" "),
          now + 30 * 86400000,
          now,
        ),
        env.DB.prepare(
          "INSERT INTO mcp_codes(hash,grant_id,redirect_uri,challenge,expires_at) VALUES(?,?,?,?,?)",
        ).bind(await hash(code), grant, redirect, challenge, now + 300000),
      ]);
      destination.searchParams.set("code", code);
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: destination.href,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (request.method === "POST" && url.pathname === "/oauth/mcp/token") {
    const params = new URLSearchParams(await smallBody(request)),
      clientId = params.get("client_id") ?? "";
    if (
      !(await readClient(env, clientId)) ||
      params.get("resource") !== resource
    )
      return oauthError("Invalid client or resource.");
    let grant: Grant | null = null;
    if (params.get("grant_type") === "authorization_code") {
      const verifier = params.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
        return oauthError("Invalid PKCE verifier.");
      const row = await env.DB.prepare(
        `DELETE FROM mcp_codes WHERE hash=? AND redirect_uri=? AND challenge=? AND expires_at>? AND grant_id IN (SELECT id FROM mcp_grants WHERE client_id=? AND resource=? AND revoked_at IS NULL AND expires_at>?) RETURNING grant_id`,
      )
        .bind(
          await hash(params.get("code") ?? ""),
          params.get("redirect_uri"),
          await hash(verifier),
          Date.now(),
          clientId,
          resource,
          Date.now(),
        )
        .first<{ grant_id: string }>();
      if (row) grant = await loadGrant(env, row.grant_id);
    } else if (params.get("grant_type") === "refresh_token") {
      const row = await env.DB.prepare(
        `DELETE FROM mcp_tokens WHERE hash=? AND kind='refresh' AND expires_at>? AND grant_id IN (SELECT id FROM mcp_grants WHERE client_id=? AND resource=? AND revoked_at IS NULL AND expires_at>?) RETURNING grant_id`,
      )
        .bind(
          await hash(params.get("refresh_token") ?? ""),
          Date.now(),
          clientId,
          resource,
          Date.now(),
        )
        .first<{ grant_id: string }>();
      if (row) grant = await loadGrant(env, row.grant_id);
    }
    if (!grant || !(await activeActor(env, grant.user_id)))
      return json({ error: "invalid_grant" }, 400);
    if (params.has("scope") && params.get("scope") !== grant.scope)
      return oauthError("Scope changes require a new authorization.");
    const access = random(),
      refresh = random(),
      expires = Math.min(Date.now() + 3600000, grant.expires_at);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mcp_tokens(hash,grant_id,kind,expires_at) VALUES(?,?,'access',?)",
      ).bind(await hash(access), grant.id, expires),
      env.DB.prepare(
        "INSERT INTO mcp_tokens(hash,grant_id,kind,expires_at) VALUES(?,?,'refresh',?)",
      ).bind(await hash(refresh), grant.id, grant.expires_at),
    ]);
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor((expires - Date.now()) / 1000),
      refresh_token: refresh,
      scope: grant.scope,
    });
  }
  if (request.method === "POST" && url.pathname === "/oauth/mcp/revoke") {
    const params = new URLSearchParams(await smallBody(request));
    await env.DB.prepare(
      "UPDATE mcp_grants SET revoked_at=? WHERE client_id=? AND id IN (SELECT grant_id FROM mcp_tokens WHERE hash=?)",
    )
      .bind(
        Date.now(),
        params.get("client_id") ?? "",
        await hash(params.get("token") ?? ""),
      )
      .run();
    return json({});
  }
  if (
    url.pathname === "/admin/chatgpt" &&
    ["GET", "POST"].includes(request.method)
  ) {
    const actor = await browserActor(request, env);
    if (!actor)
      return Response.redirect(
        origin + "/auth/login?returnTo=%2Fadmin%2Fchatgpt",
        302,
      );
    if (request.method === "POST") {
      const params = new URLSearchParams(await smallBody(request));
      if (!(await csrfForm(request, env, params)))
        return oauthError("Security token rejected.", 403);
      await env.DB.prepare(
        "UPDATE mcp_grants SET revoked_at=? WHERE id=? AND user_id=?",
      )
        .bind(Date.now(), params.get("grant_id"), actor.id)
        .run();
      return Response.redirect(origin + "/admin/chatgpt", 303);
    }
    const rows = await env.DB.prepare(
      "SELECT id,client_name,scope,created_at FROM mcp_grants WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(actor.id, Date.now())
      .all<{
        id: string;
        client_name: string;
        scope: string;
        created_at: number;
      }>();
    return page(
      env,
      "ChatGPT connections",
      (csrf) =>
        `<p>Connect the Pack 170 plugin using your CMS account. Server: <code>${esc(resource)}</code></p>${rows.results.length ? rows.results.map((g) => `<article><strong>${esc(g.client_name)}</strong><p>${esc(g.scope)} · Connected ${esc(new Date(g.created_at).toISOString().slice(0, 10))}</p><form method="post">${hidden("csrf_token", csrf)}${hidden("grant_id", g.id)}<button>Revoke connection</button></form></article>`).join("") : "<p>No active connections.</p>"}`,
    );
  }
  return json({ error: "not_found" }, 404);
}
async function loadGrant(env: McpEnv, id: string): Promise<Grant | null> {
  return env.DB.prepare(
    "SELECT id,user_id,client_id,resource,scope,expires_at FROM mcp_grants WHERE id=? AND revoked_at IS NULL AND expires_at>?",
  )
    .bind(id, Date.now())
    .first<Grant>();
}
export async function tokenActor(
  request: Request,
  env: McpEnv,
): Promise<{ actor: Actor; grant: Grant } | null> {
  const token = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([\w-]{43})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT grant_id FROM mcp_tokens WHERE hash=? AND kind='access' AND expires_at>?",
  )
    .bind(await hash(token), Date.now())
    .first<{ grant_id: string }>();
  const grant = row ? await loadGrant(env, row.grant_id) : null;
  if (!grant || grant.resource !== env.MCP_ORIGIN + "/mcp") return null;
  const actor = await activeActor(env, grant.user_id);
  return actor ? { actor, grant } : null;
}
export async function cleanMcpCredentials(env: McpEnv): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mcp_codes WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM mcp_tokens WHERE expires_at<?").bind(now),
    env.DB.prepare(
      "DELETE FROM mcp_grants WHERE expires_at<? OR revoked_at IS NOT NULL",
    ).bind(now),
    env.DB.prepare("DELETE FROM mcp_audit WHERE created_at<?").bind(
      now - 365 * 86400000,
    ),
  ]);
}
