import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthManager } from "@sonicjs-cms/core/middleware";
import {
  BROADCAST_API,
  handleBroadcastAdmin,
  handleBroadcastWebhook,
  runBroadcastDelivery,
  signedToken,
  verifyToken,
  type BroadcastBindings,
} from "./broadcasts";
import { handleBroadcastPublic } from "./broadcast-public";
import { createCmsRequestHandler } from "./request-handler";

let sqlite: DatabaseSync;
let env: BroadcastBindings;
const send = vi.fn();
type Statement = { run(): Promise<unknown> };
function adapter() {
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
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
          return { results: stmt.all(...args) };
        },
        async run() {
          return { meta: stmt.run(...args) };
        },
      };
    },
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function query(sql: string) {
  return sqlite.prepare(sql).all();
}
async function admin(path: string, body?: unknown) {
  return handleBroadcastAdmin(
    new Request("https://cms.example" + BROADCAST_API + path, {
      method: body ? "POST" : "GET",
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }),
    env,
    "admin",
  );
}
async function webhook(
  type: string,
  recipient: string,
  extra: Record<string, unknown> = {},
) {
  return handleBroadcastWebhook(
    new Request("https://cms.example/api/broadcast-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Broadcast-Secret": "hook-test",
      },
      body: JSON.stringify({
        RecordType: type,
        MessageStream: "broadcast",
        Recipient: "parent@example.test",
        MessageID: recipient,
        Metadata: { broadcastRecipient: recipient },
        ...extra,
      }),
    }),
    env,
  );
}
async function publicPost(path: string, body: Record<string, string> = {}) {
  return handleBroadcastPublic(
    new Request("https://cms.example" + path, {
      method: "POST",
      headers: {
        Origin: "https://cms.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    }),
    env,
  );
}
async function draft() {
  await admin("/drafts", {
    subject: "Pack news",
    body: "Meet us Saturday.",
    listId: "list1",
  });
  return String(
    query("SELECT id FROM broadcasts ORDER BY rowid DESC LIMIT 1")[0]!.id,
  );
}
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE permissions(id TEXT PRIMARY KEY,name TEXT,description TEXT,category TEXT,created_at INTEGER);
 CREATE TABLE role_permissions(id TEXT PRIMARY KEY,role TEXT,permission_id TEXT,created_at INTEGER);
 CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,is_active INTEGER);
 CREATE TABLE user_permissions(user_id TEXT,permission_id TEXT);
 INSERT INTO users VALUES('admin','admin',1),('volunteer','editor',1),('inactive','admin',0);`);
  const migration = readFileSync(
    "migrations/custom/0007_broadcasts.sql",
    "utf8",
  );
  sqlite.exec(migration);
  sqlite.exec(migration);
  sqlite.exec(`INSERT INTO broadcast_lists VALUES('list1','Pack news','pack-news',0),('list2','Den news','den-news',0);
 INSERT INTO broadcast_contacts VALUES('contact1','parent@example.test','Parent','',0);
 INSERT INTO broadcast_memberships VALUES('contact1','list1','active'),('contact1','list2','active');`);
  env = {
    DB: adapter(),
    JWT_SECRET: "test-broadcast-secret",
    POSTMARK_SERVER_TOKEN: "test-key",
    BROADCAST_FROM_EMAIL: "pack@example.test",
    BROADCAST_STREAM: "broadcast",
    BROADCAST_UNSUBSCRIBE_MODE: "custom",
    BROADCAST_ORIGIN: "https://cms.example",
    BROADCAST_WEBHOOK_SECRET: "hook-test",
    SIGNUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as BroadcastBindings;
  send
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ ErrorCode: 0, MessageID: crypto.randomUUID() }),
    );
  vi.stubGlobal("fetch", send);
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});
it("snapshots once, freezes the draft and delivers each recipient once", async () => {
  const id = await draft();
  expect((await admin("/send", { id })).status).toBe(200);
  await admin("/send", { id });
  expect(query("SELECT * FROM broadcast_recipients")).toHaveLength(1);
  expect(
    (
      await admin("/drafts", {
        id,
        listId: "list1",
        subject: "Changed",
        body: "Changed",
      })
    ).status,
  ).toBe(400);
  await runBroadcastDelivery(env);
  await runBroadcastDelivery(env);
  expect(send).toHaveBeenCalledTimes(1);
  const message = JSON.parse(send.mock.calls[0]![1].body);
  expect(message).toMatchObject({
    To: "parent@example.test",
    MessageStream: "broadcast",
    TrackOpens: true,
  });
  expect(message.Headers[0].Value).toContain("/email/unsubscribe/");
  expect(message.HtmlBody).toContain("Manage lists");
  expect(query("SELECT state FROM broadcasts")[0]!.state).toBe("complete");
});
it("does not retry uncertain provider outcomes", async () => {
  const id = await draft();
  await admin("/send", { id });
  send.mockRejectedValue(new Error("timeout"));
  await runBroadcastDelivery(env);
  await runBroadcastDelivery(env);
  expect(send).toHaveBeenCalledTimes(1);
  expect(query("SELECT state FROM broadcast_recipients")[0]!.state).toBe(
    "unknown",
  );
});
it("rechecks eligibility after queueing and supports removing several memberships", async () => {
  const id = await draft();
  await admin("/send", { id });
  expect(
    (
      await admin("/memberships", {
        contactId: "contact1",
        listIds: ["list1", "list2"],
        action: "remove",
      })
    ).status,
  ).toBe(200);
  await runBroadcastDelivery(env);
  expect(send).not.toHaveBeenCalled();
  expect(query("SELECT state FROM broadcast_recipients")[0]!.state).toBe(
    "skipped",
  );
  await admin("/memberships", {
    contactId: "contact1",
    listIds: ["list1", "list2"],
    action: "add",
    consent: true,
  });
  expect(query("SELECT * FROM broadcast_memberships")).toHaveLength(2);
});
it("deduplicates bounces and suppresses all lists only after two distinct messages bounce", async () => {
  const first = await draft();
  await admin("/send", { id: first });
  await runBroadcastDelivery(env);
  const r1 = String(query("SELECT id FROM broadcast_recipients")[0]!.id);
  expect((await webhook("Bounce", r1)).status).toBe(200);
  await webhook("Bounce", r1);
  expect(query("SELECT tag FROM broadcast_contacts")[0]!.tag).toBe("");
  const second = await draft();
  await admin("/send", { id: second });
  await runBroadcastDelivery(env);
  const r2 = String(
    query("SELECT id FROM broadcast_recipients ORDER BY rowid DESC")[0]!.id,
  );
  await webhook("Bounce", r2);
  expect(query("SELECT tag FROM broadcast_contacts")[0]!.tag).toBe("bounced");
  expect(
    query("SELECT * FROM broadcast_memberships WHERE state='active'"),
  ).toHaveLength(0);
  expect(
    (
      await admin("/memberships", {
        contactId: "contact1",
        listIds: ["list1"],
        action: "add",
        consent: true,
      })
    ).status,
  ).toBe(400);
});
it("tracks unique delivery and open events, rejecting bad secrets and other streams", async () => {
  const id = await draft();
  await admin("/send", { id });
  await runBroadcastDelivery(env);
  const r = String(query("SELECT id FROM broadcast_recipients")[0]!.id);
  await webhook("Delivery", r);
  await webhook("Open", r);
  await webhook("Open", r);
  await webhook("Bounce", r, { MessageStream: "outbound" });
  const result = (await (await admin("")).json()) as {
    campaigns: Array<{ delivered: number; opened: number; bounced: number }>;
  };
  expect(result.campaigns[0]).toMatchObject({
    delivered: 1,
    opened: 1,
    bounced: 0,
  });
  expect(
    (
      await handleBroadcastWebhook(
        new Request("https://cms.example/api/broadcast-webhook", {
          method: "POST",
        }),
        env,
      )
    ).status,
  ).toBe(401);
});
it("preferences unsubscribe multiple lists, cannot be forged, and cannot be undone by admin add/remove", async () => {
  const token = await signedToken(env, "preferences:contact1");
  expect(await verifyToken(env, token + "a")).toBeNull();
  const path = "/email/preferences/" + token;
  expect(
    (await publicPost(path, { list_list1: "yes", list_list2: "yes" })).status,
  ).toBe(200);
  await admin("/memberships", {
    contactId: "contact1",
    listIds: ["list1"],
    action: "remove",
  });
  await admin("/memberships", {
    contactId: "contact1",
    listIds: ["list1"],
    action: "add",
    consent: true,
  });
  expect(
    query("SELECT * FROM broadcast_memberships WHERE state='active'"),
  ).toHaveLength(0);
});
it("one-click unsubscribe needs no login and GET never mutates subscriptions", async () => {
  const path =
    "/email/unsubscribe/" +
    (await signedToken(env, "unsubscribe:contact1:list1"));
  await handleBroadcastPublic(new Request("https://cms.example" + path), env);
  expect(
    query("SELECT * FROM broadcast_memberships WHERE state='active'"),
  ).toHaveLength(2);
  const response = await handleBroadcastPublic(
    new Request("https://cms.example" + path, { method: "POST" }),
    env,
  );
  expect(response.status).toBe(200);
  expect(
    query("SELECT * FROM broadcast_memberships WHERE state='active'"),
  ).toHaveLength(1);
});
it("public signup requires consent and confirmation; confirmation cannot be replayed", async () => {
  expect(
    (await publicPost("/email/signup/pack-news", { email: "new@example.test" }))
      .status,
  ).toBe(400);
  await publicPost("/email/signup/pack-news", {
    email: "new@example.test",
    name: "New",
    consent: "yes",
  });
  const message = JSON.parse(send.mock.calls[0]![1].body);
  expect(message.MessageStream).toBe("outbound");
  expect(
    query("SELECT * FROM broadcast_memberships WHERE contact_id != 'contact1'"),
  ).toHaveLength(0);
  const link = message.TextBody.match(/https:\/\/[^\s]+/)![0];
  expect((await publicPost(new URL(link).pathname)).status).toBe(200);
  expect((await publicPost(new URL(link).pathname)).status).toBe(404);
  expect(
    query("SELECT * FROM broadcast_memberships WHERE contact_id != 'contact1'"),
  ).toHaveLength(1);
});
it("records provider suppressions and skips recipients even before the second bounce", async () => {
  await webhook("SubscriptionChange", "", {
    SuppressSending: true,
    SuppressionReason: "HardBounce",
  });
  expect(query("SELECT tag FROM broadcast_contacts")[0]!.tag).toBe(
    "suppressed",
  );
  const id = await draft();
  await admin("/send", { id });
  expect(query("SELECT * FROM broadcast_recipients")).toHaveLength(0);
});
it("enforces authentication, active accounts, explicit volunteer permissions, origin and CSRF", async () => {
  const handle = createCmsRequestHandler(() => new Response("unexpected"));
  const ctx = {} as ExecutionContext;
  expect(
    (await handle(new Request("https://cms.example" + BROADCAST_API), env, ctx))
      .status,
  ).toBe(401);
  const listPage = "https://cms.example/admin/broadcasts/lists/list1";
  expect((await handle(new Request(listPage), env, ctx)).status).toBe(302);
  for (const [user, role, status] of [
    ["admin", "admin", 200],
    ["volunteer", "editor", 403],
    ["inactive", "admin", 403],
  ] as const) {
    const token = await AuthManager.generateToken(
      user!,
      user + "@example.test",
      role!,
      env.JWT_SECRET!,
    );
    expect(
      (
        await handle(
          new Request(listPage, {
            headers: { Authorization: "Bearer " + token },
          }),
          env,
          ctx,
        )
      ).status,
    ).toBe(status);
    expect(
      (
        await handle(
          new Request("https://cms.example" + BROADCAST_API, {
            headers: { Authorization: "Bearer " + token },
          }),
          env,
          ctx,
        )
      ).status,
    ).toBe(status);
  }
  sqlite.exec(
    "INSERT INTO user_permissions VALUES('volunteer','perm_broadcasts_manage')",
  );
  const token = await AuthManager.generateToken(
    "volunteer",
    "volunteer@example.test",
    "editor",
    env.JWT_SECRET!,
  );
  const page = await handle(
    new Request("https://cms.example/admin/broadcasts", {
      headers: { Authorization: "Bearer " + token },
    }),
    env,
    ctx,
  );
  expect(page.status).toBe(200);
  expect(
    (
      await handle(
        new Request("https://cms.example" + BROADCAST_API + "/lists", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        env,
        ctx,
      )
    ).status,
  ).toBe(403);
  const cookie = page.headers.get("Set-Cookie")!.split(";")[0]!;
  const csrf = decodeURIComponent(cookie.slice("csrf_token=".length));
  expect(
    (
      await handle(
        new Request("https://cms.example" + BROADCAST_API + "/lists", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            Origin: "https://cms.example",
            Cookie: cookie,
            "X-CSRF-Token": csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "New", slug: "new" }),
        }),
        env,
        ctx,
      )
    ).status,
  ).toBe(200);
});

it("uses Postmark-managed unsubscribe headers by default with an explicit global footer", async () => {
  delete env.BROADCAST_UNSUBSCRIBE_MODE;
  const id = await draft();
  await admin("/send", { id });
  await runBroadcastDelivery(env);
  const message = JSON.parse(send.mock.calls[0]![1].body);
  expect(message.Headers).toBeUndefined();
  expect(message.HtmlBody).toContain("{{{ pm:unsubscribe }}}");
  expect(message.TextBody).toContain("Unsubscribe from all Pack broadcasts");
});

it("keeps delivery evidence when an early webhook precedes a timed-out provider response", async () => {
  const id = await draft();
  await admin("/send", { id });
  send.mockImplementation(async (_url, init) => {
    const message = JSON.parse(init.body);
    await webhook("Delivery", message.Metadata.broadcastRecipient);
    throw new Error("response lost");
  });
  await runBroadcastDelivery(env);
  expect(
    query("SELECT state,delivered FROM broadcast_recipients")[0],
  ).toMatchObject({ state: "accepted", delivered: 1 });
});

it("marks abandoned claims uncertain without retrying and rejects expired confirmations", async () => {
  const id = await draft();
  await admin("/send", { id });
  sqlite.exec("UPDATE broadcast_recipients SET state='sending',attempted_at=0");
  await runBroadcastDelivery(env);
  expect(send).not.toHaveBeenCalled();
  expect(query("SELECT state FROM broadcast_recipients")[0]!.state).toBe(
    "unknown",
  );
  sqlite.exec(
    "INSERT INTO broadcast_confirmations VALUES('expired','contact1','list1',0)",
  );
  const token = await signedToken(env, "confirm:expired");
  expect((await publicPost("/email/confirm/" + token)).status).toBe(404);
});

it("rejects insecure production unsubscribe origins and oversized bodies", async () => {
  const id = await draft();
  env.ENVIRONMENT = "production";
  env.BROADCAST_ORIGIN = "http://cms.example";
  expect((await admin("/send", { id })).status).toBe(503);
  expect(
    (
      await admin("/contacts", {
        email: "parent@example.test",
        name: "x".repeat(40001),
      })
    ).status,
  ).toBe(400);
});

it("reserves only one confirmation email across concurrent public signup requests", async () => {
  const body = { email: "new@example.test", consent: "yes" };
  const responses = await Promise.all([
    publicPost("/email/signup/pack-news", body),
    publicPost("/email/signup/pack-news", body),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(query("SELECT * FROM broadcast_confirmations")).toHaveLength(1);
});

it("confirms separate public list signups independently within the same hour", async () => {
  const body = { email: "new@example.test", consent: "yes" };
  await publicPost("/email/signup/pack-news", body);
  await publicPost("/email/signup/den-news", body);
  expect(send).toHaveBeenCalledTimes(2);
  expect(query("SELECT * FROM broadcast_confirmations")).toHaveLength(2);
});

it("allows confirmation retries after a definitive rejection but keeps ambiguous reservations", async () => {
  const body = { email: "new@example.test", consent: "yes" };
  send.mockResolvedValueOnce(new Response("Rejected", { status: 422 }));
  expect((await publicPost("/email/signup/pack-news", body)).status).toBe(503);
  expect(query("SELECT * FROM broadcast_confirmations")).toHaveLength(0);
  expect((await publicPost("/email/signup/pack-news", body)).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(2);
  send.mockRejectedValueOnce(new Error("timeout"));
  expect((await publicPost("/email/signup/den-news", body)).status).toBe(503);
  await publicPost("/email/signup/den-news", body);
  expect(send).toHaveBeenCalledTimes(3);
});
it("edits a list without changing memberships and rejects invalid or duplicate slugs", async () => {
  expect(
    (
      await admin("/lists", {
        id: "list1",
        name: "Announcements",
        slug: "announcements",
      })
    ).status,
  ).toBe(200);
  expect((await (await admin("/lists/list1")).json()) as object).toMatchObject({
    list: { id: "list1", name: "Announcements", slug: "announcements" },
    contacts: [{ id: "contact1" }],
  });
  expect(query("SELECT * FROM broadcast_memberships")).toHaveLength(2);
  expect(
    (await admin("/lists", { id: "list1", name: "Bad", slug: "den-news" }))
      .status,
  ).toBe(409);
  expect(
    (await admin("/lists", { id: "list1", name: "Bad", slug: "UPPER" })).status,
  ).toBe(400);
  expect(
    (await admin("/lists", { id: "missing", name: "Missing", slug: "missing" }))
      .status,
  ).toBe(404);
  expect((await admin("/lists/missing")).status).toBe(404);
});
it("list details exclude removed members without removing contacts or their other lists", async () => {
  await admin("/memberships", {
    contactId: "contact1",
    listIds: ["list1"],
    action: "remove",
  });
  expect((await (await admin("/lists/list1")).json()) as object).toMatchObject({
    contacts: [],
  });
  expect((await (await admin("/lists/list2")).json()) as object).toMatchObject({
    contacts: [{ id: "contact1" }],
  });
  expect(query("SELECT * FROM broadcast_contacts")).toHaveLength(1);
});
