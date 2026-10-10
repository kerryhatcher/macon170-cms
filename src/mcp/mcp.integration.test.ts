import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AuthManager, csrfProtection } from "@sonicjs-cms/core/middleware";
import {
  apiContentCrudRoutes,
  apiRoutes,
  adminUsersRoutes,
} from "@sonicjs-cms/core/routes";
import { Hono } from "hono";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { handleMcp } from "./index";
import { hash, type McpEnv } from "./security";
import { cleanMcpCredentials } from "./oauth";
import { createCmsRequestHandler } from "../request-handler";
import { renderLoginPage } from "../login-page";

const origin = "https://cms.example";
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "x".repeat(64);
let db: DatabaseSync, env: McpEnv, browser: string;
const send = vi.fn();
const app = new Hono<{ Bindings: McpEnv }>();
app.use("*", csrfProtection());
app.route("/api/content", apiContentCrudRoutes);
app.route("/api", apiRoutes);
app.route("/admin", adminUsersRoutes);
const handler = createCmsRequestHandler(app.fetch.bind(app));
const route = async (request: Request) =>
  (await handleMcp(request, env, async (next) =>
    handler(next, env, {} as ExecutionContext),
  ))!;
async function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return route(
    new Request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
}
async function register() {
  const res = await request("/oauth/mcp/register", {
    redirect_uris: [redirect],
    client_name: "ChatGPT",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}
async function authorize(scope = "cms:read cms:write cms:send") {
  const client = await register();
  const params = new URLSearchParams({
    client_id: client,
    redirect_uri: redirect,
    response_type: "code",
    resource: origin + "/mcp",
    scope,
    state: "state-test",
    code_challenge_method: "S256",
    code_challenge: await hash(verifier),
  });
  const path = "/oauth/mcp/authorize?" + params;
  const page = await request(path, undefined, { Cookie: browser });
  expect(page.status).toBe(200);
  const csrfCookie = page.headers.get("Set-Cookie")!.split(";")[0]!;
  const csrf = decodeURIComponent(csrfCookie.slice("csrf_token=".length));
  const form = new URLSearchParams(params);
  form.set("csrf_token", csrf);
  form.set("decision", "allow");
  const consent = await request("/oauth/mcp/authorize", form.toString(), {
    Cookie: browser + "; " + csrfCookie,
    Origin: origin,
    "Content-Type": "application/x-www-form-urlencoded",
  });
  expect(consent.status).toBe(302);
  const location = new URL(consent.headers.get("Location")!);
  expect(location.searchParams.get("state")).toBe("state-test");
  expect(location.searchParams.get("iss")).toBe(origin);
  return {
    client,
    code: location.searchParams.get("code")!,
    params,
    csrfCookie,
    form,
  };
}
async function exchange(
  client: string,
  code: string,
  changes: Record<string, string> = {},
) {
  return request(
    "/oauth/mcp/token",
    new URLSearchParams({
      client_id: client,
      code,
      redirect_uri: redirect,
      resource: origin + "/mcp",
      grant_type: "authorization_code",
      code_verifier: verifier,
      ...changes,
    }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" },
  );
}
async function connect(scope?: string) {
  const auth = await authorize(scope);
  const response = await exchange(auth.client, auth.code);
  expect(response.status).toBe(200);
  return {
    ...auth,
    ...((await response.json()) as {
      access_token: string;
      refresh_token: string;
    }),
  };
}
async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await request(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method, params },
    {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result: {
      tools: {
        name: string;
        annotations: { readOnlyHint: boolean; openWorldHint: boolean };
      }[];
      isError?: boolean;
      content: { text: string }[];
    };
    error?: unknown;
  };
}
async function tool(token: string, name: string, args: unknown = {}) {
  return (await rpc(token, "tools/call", { name, arguments: args })).result;
}
const event = {
  slug: "pack-meeting",
  title: "Pack meeting",
  summary: "Meet the Pack this month.",
  description: "Bring the family for a fun Pack meeting.",
  category: "pack",
  eventStatus: "scheduled",
  startsAt: "2026-11-10T18:00:00-05:00",
  endsAt: null,
  allDay: false,
  timezone: "America/New_York",
  audience: "Pack families",
};
beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  for (const dir of [
    "node_modules/@sonicjs-cms/core/migrations",
    "migrations/custom",
  ]) {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(dir + "/" + file, "utf8"));
  }
  db.exec(
    "INSERT INTO users(id,email,username,first_name,last_name,role,is_active,created_at,updated_at) VALUES('admin-mcp','admin@example.test','admin-mcp','Admin','Test','admin',1,0,0)",
  );
  const adapter = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let args: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) {
          args = values;
          return this;
        },
        async first() {
          return stmt.get(...args) ?? null;
        },
        async all() {
          return { results: stmt.all(...args), success: true };
        },
        async run() {
          const meta = stmt.run(...args);
          return { success: true, meta };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  env = {
    DB: adapter,
    JWT_SECRET: "mcp-integration-test-secret",
    MCP_ORIGIN: origin,
    POSTMARK_SERVER_TOKEN: "test-provider",
    INVITE_FROM_EMAIL: "volunteers@example.test",
    BROADCAST_FROM_EMAIL: "volunteers@example.test",
    BROADCAST_STREAM: "broadcasts",
    BROADCAST_ORIGIN: origin,
    BROADCAST_WEBHOOK_SECRET: "test-webhook",
    BROADCAST_UNSUBSCRIBE_MODE: "custom",
  } as unknown as McpEnv;
  browser =
    "auth_token=" +
    (await AuthManager.generateToken(
      "admin-mcp",
      "admin@example.test",
      "admin",
      env.JWT_SECRET,
    ));
  send
    .mockReset()
    .mockResolvedValue(
      Response.json({ ErrorCode: 0, MessageID: "test-message" }),
    );
  vi.stubGlobal("fetch", send);
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("ChatGPT OAuth and MCP", () => {
  it("advertises discovery and rejects browser cookies, foreign origins and foreign hosts at MCP", async () => {
    expect(
      (await request("/.well-known/oauth-authorization-server")).status,
    ).toBe(200);
    const noToken = await request("/mcp", {}, { Cookie: browser });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata",
    );
    expect(
      (await request("/mcp", {}, { Origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await route(new Request("https://evil.example/mcp"))).status).toBe(
      403,
    );
  });
  it("supports sign-in continuation without accepting external login return URLs", async () => {
    const client = await register(),
      params = new URLSearchParams({
        client_id: client,
        redirect_uri: redirect,
        resource: origin + "/mcp",
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: await hash(verifier),
      });
    const res = await request("/oauth/mcp/authorize?" + params);
    expect(res.status).toBe(302);
    for (const incomingOrigin of ["null", "https://external-client.example"]) {
      expect((await request("/oauth/mcp/authorize?" + params, undefined, {
        Origin: incomingOrigin,
      })).status).toBe(302);
      expect((await request("/oauth/mcp/authorize?" + params, undefined, {
        Origin: incomingOrigin, Cookie: browser,
      })).status).toBe(200);
      expect((await request("/oauth/mcp/authorize", params.toString(), {
        Origin: incomingOrigin, Cookie: browser,
      })).status).toBe(403);
      expect((await request("/mcp", {}, {Origin: incomingOrigin})).status).toBe(403);
    }
    const login = new URL(res.headers.get("Location")!);
    expect(renderLoginPage(login)).toContain("/oauth/mcp/authorize?");
    expect(
      renderLoginPage(new URL(origin + "/auth/login?returnTo=//evil.example")),
    ).not.toContain("//evil.example");
  });
  it("enforces exact redirects, signed client IDs, resource binding and CSRF", async () => {
    const a = await authorize();
    const bad = new URLSearchParams(a.params);
    bad.set("redirect_uri", "https://evil.example/callback");
    expect(
      (
        await request("/oauth/mcp/authorize?" + bad, undefined, {
          Cookie: browser,
        })
      ).status,
    ).toBe(400);
    bad.set("client_id", a.client + "bad");
    expect(
      (
        await request("/oauth/mcp/authorize?" + bad, undefined, {
          Cookie: browser,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/oauth/mcp/authorize", a.form.toString(), {
          Cookie: browser,
          Origin: origin,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await exchange(a.client, a.code, {
          resource: "https://other.example/mcp",
        })
      ).status,
    ).toBe(400);
    expect(
      (await exchange(a.client, a.code, { code_verifier: "y".repeat(64) }))
        .status,
    ).toBe(400);
    const tokens = await (await exchange(a.client, a.code)).json() as {access_token: string};
    expect(tokens.access_token).toBeTruthy();
    expect((await exchange(a.client, a.code)).status).toBe(400);
    expect((await request("/mcp", {}, {Authorization: "Bearer " + tokens.access_token})).status).toBe(401);
  });
  it("rejects reused refresh credentials and stops access on revocation or account deactivation", async () => {
    let a = await connect();
    const body = new URLSearchParams({
      client_id: a.client,
      grant_type: "refresh_token",
      refresh_token: a.refresh_token,
      resource: origin + "/mcp",
    }).toString();
    const rotated = await (await request("/oauth/mcp/token", body)).json() as {access_token: string};
    expect(rotated.access_token).toBeTruthy();
    expect((await request("/oauth/mcp/token", body)).status).toBe(400);
    expect((await request("/mcp", {}, {Authorization: "Bearer " + rotated.access_token})).status).toBe(401);
    a = await connect();
    db.exec("UPDATE users SET is_active=0 WHERE id='admin-mcp'");
    expect(
      (await request("/mcp", {}, { Authorization: "Bearer " + a.access_token }))
        .status,
    ).toBe(401);
    db.exec("UPDATE users SET is_active=1 WHERE id='admin-mcp'");
    await request(
      "/oauth/mcp/revoke",
      new URLSearchParams({
        client_id: a.client,
        token: a.access_token,
      }).toString(),
    );
    expect(
      (await request("/mcp", {}, { Authorization: "Bearer " + a.access_token }))
        .status,
    ).toBe(401);
  });
  it("registers tools with side-effect annotations and enforces read-only grants", async () => {
    const a = await connect("cms:read");
    const initialized = await rpc(a.access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.error).toBeUndefined();
    const tools = (await rpc(a.access_token, "tools/list")).result.tools;
    expect(tools.length).toBe(31);
    expect(
      tools.find((t) => t.name === "send_email_broadcast")?.annotations,
    ).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect((await tool(a.access_token, "list_calendar_events")).isError).toBe(
      false,
    );
    expect(
      (await tool(a.access_token, "create_calendar_event", event)).isError,
    ).toBe(true);
    expect(
      db.prepare("SELECT count(*) AS n FROM calendar_events").get()!.n,
    ).toBe(0);
  });
  it("uses real calendar handlers, preserves revisions and enforces live CMS permissions", async () => {
    const a = await connect();
    const created = await tool(a.access_token, "create_calendar_event", event);
    expect(created.isError).toBe(false);
    const row = JSON.parse(created.content[0]!.text).data.event;
    expect(row.publicationState).toBe("draft");
    expect(
      (
        await tool(a.access_token, "publish_calendar_event", {
          id: row.id,
          expectedRevision: row.revision,
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await tool(a.access_token, "update_calendar_event", {
          id: row.id,
          expectedRevision: row.revision,
          changes: { title: "Conflicting edit" },
        })
      ).isError,
    ).toBe(true);
    db.exec(
      "DELETE FROM role_permissions WHERE role='admin' AND permission_id='perm_calendar_manage'",
    );
    expect(
      (
        await tool(a.access_token, "create_calendar_event", {
          ...event,
          slug: "den-meeting",
        })
      ).isError,
    ).toBe(true);
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM mcp_audit WHERE tool='publish_calendar_event' AND success=1",
        )
        .get()!.n,
    ).toBe(1);
  });
  it("creates drafts and queues broadcasts through existing consent and suppression rules without sending during the request", async () => {
    const a = await connect();
    expect(
      (
        await tool(a.access_token, "save_mailing_list", {
          name: "Pack news",
          slug: "pack-news",
        })
      ).isError,
    ).toBe(false);
    const list = db.prepare("SELECT id FROM broadcast_lists").get()!.id;
    expect(
      (
        await tool(a.access_token, "save_email_contact", {
          email: "parent@example.test",
          name: "Parent",
        })
      ).isError,
    ).toBe(false);
    const contact = db.prepare("SELECT id FROM broadcast_contacts").get()!.id;
    expect(
      (
        await tool(a.access_token, "update_mailing_memberships", {
          contactId: contact,
          listIds: [list],
          action: "add",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await tool(a.access_token, "update_mailing_memberships", {
          contactId: contact,
          listIds: [list],
          action: "add",
          consent: true,
        })
      ).isError,
    ).toBe(false);
    const draft = await tool(a.access_token, "save_email_draft", {
      listId: list,
      subject: "Pack news",
      body: "Meet on Tuesday.",
    });
    expect(draft.isError).toBe(false);
    const workspace = await tool(a.access_token, "list_email_workspace");
    const draftId = JSON.parse(workspace.content[0]!.text).data.campaigns[0].id;
    expect(
      (await tool(a.access_token, "send_email_broadcast", { id: draftId }))
        .isError,
    ).toBe(false);
    expect(
      (await tool(a.access_token, "send_email_broadcast", { id: draftId }))
        .isError,
    ).toBe(false);
    expect(
      db.prepare("SELECT count(*) AS n FROM broadcast_recipients").get()!.n,
    ).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("sends invitations through the patched SonicJS route and hides the setup token", async () => {
    const a = await connect();
    const result = await tool(a.access_token, "invite_volunteer", {
      email: "new@example.test",
      first_name: "New",
      last_name: "Volunteer",
      role: "editor",
    });
    expect(result.isError).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const user = db
      .prepare(
        "SELECT invitation_token,role FROM users WHERE email='new@example.test'",
      )
      .get()!;
    expect(user.role).toBe("editor");
    expect(JSON.stringify(result)).not.toContain(user.invitation_token);
    const pending = await tool(a.access_token, "list_pending_invitations");
    expect(JSON.stringify(pending)).not.toContain(user.invitation_token);
  });
  it("manages leadership through SonicJS and rejects IDs from other collections", async () => {
    db.exec(
      `INSERT INTO collections(id,name,display_name,schema,created_at,updated_at) VALUES('roster','leadership-roster','Leadership','{"type":"object","properties":{}}',0,0)`,
    );
    const a = await connect();
    const data = {
      title: "Cubmaster",
      name: "Test Volunteer",
      section: "pack-leadership",
      sortOrder: 10,
    };
    const created = await tool(a.access_token, "create_leadership_role", {
      slug: "cubmaster",
      status: "draft",
      data,
    });
    expect(created.isError, JSON.stringify(created)).toBe(false);
    const row = db
      .prepare("SELECT id FROM content WHERE collection_id='roster'")
      .get()!;
    expect(
      (await tool(a.access_token, "get_leadership_role", { id: row.id }))
        .isError,
    ).toBe(false);
    expect(
      (
        await tool(a.access_token, "update_leadership_role", {
          id: row.id,
          data: { ...data, name: "" },
          status: "published",
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await tool(a.access_token, "get_leadership_role", {
          id: "other-content",
        })
      ).isError,
    ).toBe(true);
    expect(
      (await tool(a.access_token, "delete_leadership_role", { id: row.id }))
        .isError,
    ).toBe(false);
  });
  it("creates and revises signup forms attached to a real calendar event", async () => {
    const a = await connect();
    const created = await tool(a.access_token, "create_calendar_event", event);
    const eventId = JSON.parse(created.content[0]!.text).data.event.id;
    const form = {
      slug: "meeting-rsvp",
      eventId,
      formType: "rsvp",
      title: "Meeting RSVP",
      instructions: "Let us know.",
      state: "draft",
      closesAt: null,
      slots: [],
    };
    const result = await tool(a.access_token, "create_signup_form", form);
    expect(result.isError, JSON.stringify(result)).toBe(false);
    const saved = JSON.parse(result.content[0]!.text).data.form;
    expect(
      (
        await tool(a.access_token, "update_signup_form", {
          id: saved.id,
          expectedRevision: saved.revision,
          form: { ...form, state: "closed" },
        })
      ).isError,
    ).toBe(false);
    expect(
      (await tool(a.access_token, "get_signup_form", { id: saved.id })).isError,
    ).toBe(false);
  });
  it("previews sanitized HTML and preserves rich drafts unless a conversion is explicit", async () => {
    const a = await connect();
    await tool(a.access_token, "save_mailing_list", {
      name: "Pack news",
      slug: "pack-news",
    });
    const list = db.prepare("SELECT id FROM broadcast_lists").get()!.id;
    const html = "<p><strong>Pack update</strong></p><script>alert(1)</script>";
    const preview = await tool(a.access_token, "preview_email", {
      subject: "Pack news",
      body: "Pack update",
      html,
    });
    expect(preview.isError).toBe(false);
    expect(preview.content[0]!.text).toContain("<strong>Pack update</strong>");
    expect(preview.content[0]!.text).not.toContain("<script>");
    const draft = await tool(a.access_token, "save_email_draft", {
      listId: list,
      subject: "Pack news",
      body: "Pack update",
      html,
    });
    expect(draft.isError).toBe(false);
    const id = JSON.parse(draft.content[0]!.text).data.id;
    expect(
      (
        await tool(a.access_token, "save_email_draft", {
          id,
          listId: list,
          subject: "Updated",
          body: "Pack update",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await tool(a.access_token, "save_email_draft", {
          id,
          listId: list,
          subject: "Updated",
          body: "Pack update",
          html: "",
        })
      ).isError,
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it("supports native loopback callbacks but rejects insecure remote callbacks", async () => {
    for (const uri of [
      "http://127.0.0.1:43219/callback",
      "http://[::1]:43219/callback",
    ]) {
      expect(
        (await request("/oauth/mcp/register", { redirect_uris: [uri] })).status,
      ).toBe(201);
    }
    for (const uri of [
      "http://evil.example/callback",
      "http://127.0.0.1.evil.example/callback",
      "https://user:password@example.test/callback",
      "https://example.test/callback#fragment",
    ]) {
      expect(
        (await request("/oauth/mcp/register", { redirect_uris: [uri] })).status,
      ).toBe(400);
    }
    const a = await connect();
    const response = await request("/mcp", undefined, {
      Authorization: "Bearer " + a.access_token,
      Accept: "text/event-stream",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
  it("expires credentials, cleans storage, and bounds incoming bodies", async () => {
    const a = await connect();
    db.exec("UPDATE mcp_tokens SET expires_at=0");
    expect(
      (await request("/mcp", {}, { Authorization: "Bearer " + a.access_token }))
        .status,
    ).toBe(401);
    await cleanMcpCredentials(env);
    expect(db.prepare("SELECT count(*) AS n FROM mcp_tokens").get()!.n).toBe(0);
    expect(
      (await request("/oauth/mcp/register", {redirect_uris: [redirect], client_name: "x".repeat(17000)})).status,
    ).toBe(400);
  });
});
