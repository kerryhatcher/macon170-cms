import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { AuthManager, generateCsrfToken } from "@sonicjs-cms/core/middleware";
import {
  handleInboundWebhook,
  handleInboxAdmin,
  type InboundBindings,
  parseInbound,
} from "./inbound-email";
import { createCmsRequestHandler } from "./request-handler";
import { renderInboxPage } from "./inbox-page";
let db: DatabaseSync, env: InboundBindings;
let store: Map<string, string>;
type TestResult = {
  emails: {
    id: string;
    contact_id: string | null;
    contact_name: string;
    subject: string;
  }[];
  contact: { email: string };
  hasMore: boolean;
  content: { text: string };
};
async function data(response: Promise<Response>): Promise<TestResult> {
  return (await (await response).json()) as TestResult;
}

const id = "12345678-1234-4321-8321-123456789012";
function adapter() {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let args: SQLInputValue[] = [];
      return {
        bind(...v: SQLInputValue[]) {
          args = v;
          return this;
        },
        async first() {
          return stmt.get(...args) ?? null;
        },
        async all() {
          return { results: stmt.all(...args) };
        },
        async run() {
          const r = stmt.run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      db.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
function payload(extra: Record<string, unknown> = {}) {
  return {
    MessageID: id,
    MessageStream: "inbound",
    OriginalRecipient: "contact@macon170.com",
    FromFull: { Email: "Parent@Example.test", Name: "Parent" },
    Subject: "Help with camping",
    TextBody: "When do we meet?",
    HtmlBody: "<script>alert(1)</script>",
    Date: "Fri, 9 Oct 2026 12:00:00 -0400",
    Attachments: [
      {
        Name: "note.html",
        Content: btoa("<script>bad()</script>"),
        ContentType: "text/html",
        ContentLength: 22,
      },
    ],
    ...extra,
  };
}
function webhook(
  extra: Record<string, unknown> = {},
  authorization = "Basic " + btoa("postmark:secret"),
) {
  return handleInboundWebhook(
    new Request("https://cms.example/api/inbound-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify(payload(extra)),
    }),
    env,
  );
}
function admin(path = "", body?: unknown) {
  return handleInboxAdmin(
    new Request("https://cms.example/api/inbox/v1" + path, {
      method: body ? "PATCH" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    "admin",
  );
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE permissions(id TEXT PRIMARY KEY,name TEXT,description TEXT,category TEXT,created_at INTEGER); CREATE TABLE role_permissions(id TEXT PRIMARY KEY,role TEXT,permission_id TEXT,created_at INTEGER); CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,is_active INTEGER); CREATE TABLE user_permissions(user_id TEXT,permission_id TEXT); INSERT INTO users VALUES('admin','admin',1),('volunteer','editor',1),('inactive','admin',0);`,
  );
  db.exec(readFileSync("migrations/custom/0007_broadcasts.sql", "utf8"));
  db.exec(readFileSync("migrations/custom/0010_inbound_email.sql", "utf8"));
  store = new Map();
  env = {
    DB: adapter(),
    JWT_SECRET: "test-inbox-secret",
    INBOUND_WEBHOOK_SECRET: "secret",
    INBOUND_BUCKET: {
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async get(key: string) {
        const value = store.get(key);
        return value
          ? {
              async json() {
                return JSON.parse(value);
              },
            }
          : null;
      },
    },
  } as unknown as InboundBindings;
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});
it("authenticates provider, validates domain/stream/attachments, and never stores unauthenticated mail", async () => {
  expect((await webhook({}, "")).status).toBe(401);
  expect(store.size).toBe(0);
  for (const extra of [
    { OriginalRecipient: "other@example.test" },
    { MessageStream: "outbound" },
    { Attachments: [{ Name: "bad", Content: "!", ContentLength: 1 }] },
    { MessageID: "../secret" },
  ])
    expect((await webhook(extra)).status).toBe(422);
  expect(store.size).toBe(0);
  expect((await webhook()).status).toBe(200);
  expect((await admin()).status).toBe(200);
});
it("preserves review status across duplicate and concurrent webhook retries, audits status once, rejects stale revisions", async () => {
  await Promise.all([webhook(), webhook()]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM inbound_emails").get()!.n).toBe(
    1,
  );
  expect(
    (await admin("/" + id, { status: "reviewed", expectedRevision: 0 })).status,
  ).toBe(200);
  expect(
    (await admin("/" + id, { status: "spam", expectedRevision: 0 })).status,
  ).toBe(409);
  await webhook();
  expect(db.prepare("SELECT status FROM inbound_emails").get()!.status).toBe(
    "reviewed",
  );
  expect(db.prepare("SELECT COUNT(*) AS n FROM inbound_audit").get()!.n).toBe(
    1,
  );
});
it("links existing and subsequently created contacts case-insensitively and returns contact history", async () => {
  await webhook();
  expect((await data(admin())).emails[0].contact_id).toBeNull();
  db.prepare(
    "INSERT INTO broadcast_contacts VALUES('contact1','PARENT@example.test','Known Parent','',0)",
  ).run();
  const result = await data(admin("?contactId=contact1"));
  expect(result.emails).toHaveLength(1);
  expect(result.emails[0].contact_name).toBe("Known Parent");
  expect(result.contact.email).toBe("PARENT@example.test");
  expect((await data(admin("?contactId=other"))).emails).toHaveLength(0);
});
it("filters, sorts, and paginates beyond 25 messages without injection", async () => {
  for (let i = 0; i < 28; i++)
    await webhook({
      MessageID: "12345678-1234-4321-8321-" + String(i).padStart(12, "0"),
      Subject: String(i).padStart(2, "0"),
      OriginalRecipient: i % 2 ? "den@macon170.com" : "contact@macon170.com",
    });
  const first = await data(admin("?sort=subject&direction=asc"));
  expect(first.emails).toHaveLength(25);
  expect(first.hasMore).toBe(true);
  expect(first.emails[0].subject).toBe("00");
  const last = await data(admin("?sort=subject&direction=asc&page=2"));
  expect(last.emails).toHaveLength(3);
  expect(last.hasMore).toBe(false);
  expect(
    (await data(admin("?recipient=den@macon170.com"))).emails,
  ).toHaveLength(14);
  expect(
    (await data(admin("?sender=parent@example.test&q=27"))).emails,
  ).toHaveLength(1);
  expect((await data(admin("?status=archived"))).emails).toHaveLength(0);
  expect((await data(admin("?after=2100-01-01"))).emails).toHaveLength(0);
  for (const query of [
    "?sort=DROP%20TABLE",
    "?direction=no",
    "?page=-1",
    "?after=no",
  ])
    expect((await admin(query)).status).toBe(400);
});
it("returns safe text and authenticated attachment downloads without HTML execution or tracking images", async () => {
  await webhook({
    TextBody: "",
    HtmlBody:
      '<p>Hello</p><script>bad()</script><img src="https://tracker.example/x">',
  });
  const detail = await data(admin("/" + id));
  expect(detail.content.text).toContain("Hello");
  expect(detail.content.text).not.toContain("<script>");
  expect(detail.content).not.toHaveProperty("html");
  const file = await admin("/" + id + "/attachments/0");
  expect(file.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(file.headers.get("Content-Disposition")).toContain("attachment;");
  expect(await file.text()).toBe("<script>bad()</script>");
  expect((await admin("/" + id + "/attachments/9")).status).toBe(404);
});
it("does not acknowledge storage failures and handles declared and streamed size limits", async () => {
  vi.spyOn(env.INBOUND_BUCKET, "put").mockRejectedValueOnce(new Error("disk"));
  expect((await webhook()).status).toBe(503);
  expect(db.prepare("SELECT COUNT(*) AS n FROM inbound_emails").get()!.n).toBe(
    0,
  );
  const response = await handleInboundWebhook(
    new Request("https://cms.example/api/inbound-webhook", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa("postmark:secret"),
        "Content-Type": "application/json",
        "Content-Length": String(21 * 1024 * 1024),
      },
      body: "{}",
    }),
    env,
  );
  expect(response.status).toBe(422);
  expect(() =>
    parseInbound(
      payload({
        Attachments: [{ Name: "empty", Content: "", ContentLength: 0 }],
      }),
    ),
  ).not.toThrow();
});
it("requires active account and inbox permission for list, details and attachments; mutations require CSRF", async () => {
  const handler = createCmsRequestHandler(async () => new Response("fallback"));
  await webhook();
  async function route(
    path: string,
    user?: string,
    body?: unknown,
    csrf?: string,
  ) {
    const jwt = user
      ? await AuthManager.generateToken(
          user,
          "user@example.test",
          "admin",
          env.JWT_SECRET!,
        )
      : "";
    return handler(
      new Request("https://cms.example" + path, {
        method: body ? "PATCH" : "GET",
        headers: {
          Authorization: "Bearer " + jwt,
          Origin: "https://cms.example",
          "Content-Type": "application/json",
          ...(csrf
            ? {
                "X-CSRF-Token": csrf,
                Cookie: "csrf_token=" + encodeURIComponent(csrf),
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      {} as ExecutionContext,
    );
  }
  expect((await route("/admin/inbox")).status).toBe(302);
  for (const path of [
    "/api/inbox/v1",
    "/api/inbox/v1/" + id,
    "/api/inbox/v1/" + id + "/attachments/0",
  ]) {
    expect((await route(path)).status).toBe(401);
    expect((await route(path, "volunteer")).status).toBe(403);
    expect((await route(path, "inactive")).status).toBe(403);
    expect((await route(path, "admin")).status).toBe(200);
  }
  expect(
    (
      await route("/api/inbox/v1/" + id, "admin", {
        status: "reviewed",
        expectedRevision: 0,
      })
    ).status,
  ).toBe(403);
  const csrf = await generateCsrfToken(env.JWT_SECRET!);
  expect(
    (
      await route(
        "/api/inbox/v1/" + id,
        "admin",
        { status: "reviewed", expectedRevision: 0 },
        csrf,
      )
    ).status,
  ).toBe(200);
  db.prepare(
    "INSERT INTO role_permissions VALUES('editor-inbox','editor','perm_inbox_manage',0)",
  ).run();
  expect((await route("/admin/inbox", "volunteer")).status).toBe(200);
});
it("renders accessible inbox controls without interpolating message content into scripts", () => {
  const page = renderInboxPage("<unsafe>");
  expect(page).toContain("Sort by");
  expect(page).toContain("From address");
  expect(page).toContain("textContent=data.content.text");
  expect(page).not.toContain('content="<unsafe>"');
});
