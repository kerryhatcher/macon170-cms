import { timingSafeEqual } from "node:crypto";
import type { Bindings } from "@sonicjs-cms/core";
import {
  isPostmarkConfigured,
  sendPostmarkEmail,
  type PostmarkBindings,
} from "./postmark";

export type BroadcastBindings = Bindings &
  PostmarkBindings & {
    BROADCAST_FROM_EMAIL?: string;
    BROADCAST_STREAM?: string;
    BROADCAST_UNSUBSCRIBE_MODE?: "postmark" | "custom";
    BROADCAST_ORIGIN?: string;
    BROADCAST_WEBHOOK_SECRET?: string;
    SIGNUP_RATE_LIMITER?: {
      limit(input: { key: string }): Promise<{ success: boolean }>;
    };
  };
export const BROADCAST_API = "/api/broadcasts/v1";
export const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export class BroadcastError extends Error {}
export function required(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new BroadcastError(
      "Please complete all fields within their length limits.",
    );
  return value.trim();
}
export function emailAddress(value: unknown): string {
  const email = required(value, 254).toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email))
    throw new BroadcastError("Enter a valid email address.");
  return email;
}
export async function readInput(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new BroadcastError("Missing request body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 40000) {
      await reader.cancel();
      throw new BroadcastError("Request too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = new TextDecoder().decode(bytes);
  if (request.headers.get("Content-Type")?.includes("application/json")) {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      /* handled below */
    }
    throw new BroadcastError("Invalid JSON.");
  }
  return Object.fromEntries(new URLSearchParams(raw));
}
function configured(env: BroadcastBindings): boolean {
  try {
    const origin = new URL(env.BROADCAST_ORIGIN ?? "");
    if (
      origin.origin !== env.BROADCAST_ORIGIN ||
      (env.ENVIRONMENT === "production" && origin.protocol !== "https:")
    )
      return false;
    emailAddress(env.BROADCAST_FROM_EMAIL);
  } catch {
    return false;
  }
  return (
    isPostmarkConfigured(env) &&
    !!env.BROADCAST_FROM_EMAIL &&
    !!env.BROADCAST_STREAM &&
    env.BROADCAST_STREAM !== "outbound" &&
    !!env.BROADCAST_ORIGIN &&
    !!env.JWT_SECRET &&
    !!env.BROADCAST_WEBHOOK_SECRET &&
    [undefined, "postmark", "custom"].includes(env.BROADCAST_UNSUBSCRIBE_MODE)
  );
}
export async function signedToken(
  env: BroadcastBindings,
  payload: string,
): Promise<string> {
  if (!env.JWT_SECRET)
    throw new BroadcastError("Security configuration unavailable.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("broadcast:" + payload),
  );
  return (
    btoa(payload)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "") +
    "." +
    Array.from(new Uint8Array(signature), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export async function verifyToken(
  env: BroadcastBindings,
  token: string,
): Promise<string | null> {
  try {
    if (token.length > 2000) return null;
    const payload = atob(
      token.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/"),
    );
    const expected = await signedToken(env, payload);
    return (await equalSecret(token, expected)) ? payload : null;
  } catch {
    return null;
  }
}
async function equalSecret(a: string, b: string): Promise<boolean> {
  const hash = (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
export async function handleBroadcastAdmin(
  request: Request,
  env: BroadcastBindings,
  actor: string,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname.slice(BROADCAST_API.length);
    const db = env.DB;
    if (request.method === "GET" && path.startsWith("/lists/")) {
      const id = path.slice("/lists/".length);
      const list = await db
        .prepare("SELECT * FROM broadcast_lists WHERE id=?")
        .bind(id)
        .first();
      if (!list) return json({ message: "List not found." }, 404);
      const contacts = await db
        .prepare(
          "SELECT c.* FROM broadcast_contacts c JOIN broadcast_memberships m ON m.contact_id=c.id WHERE m.list_id=? AND m.state='active' ORDER BY c.email",
        )
        .bind(id)
        .all();
      return json({ list, contacts: contacts.results });
    }
    if (request.method === "GET" && path === "") {
      const [lists, contacts, memberships, campaigns] = await Promise.all([
        db
          .prepare(
            "SELECT l.*, (SELECT COUNT(*) FROM broadcast_memberships m JOIN broadcast_contacts c ON c.id=m.contact_id WHERE m.list_id=l.id AND m.state='active' AND c.tag='') AS members FROM broadcast_lists l ORDER BY name",
          )
          .all(),
        db
          .prepare("SELECT * FROM broadcast_contacts ORDER BY email LIMIT 5000")
          .all(),
        db
          .prepare(
            "SELECT * FROM broadcast_memberships WHERE state='active' LIMIT 20000",
          )
          .all(),
        db
          .prepare(
            `SELECT b.*, COUNT(r.id) AS recipients, COALESCE(SUM(r.state='accepted'),0) AS accepted,
    COALESCE(SUM(r.delivered),0) AS delivered, COALESCE(SUM(r.opened),0) AS opened, COALESCE(SUM(r.clicked),0) AS clicked,
    COALESCE(SUM(r.bounced),0) AS bounced, COALESCE(SUM(r.state='unknown'),0) AS unknown,
    COALESCE(SUM(r.state='skipped'),0) AS skipped FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.broadcast_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 200`,
          )
          .all(),
      ]);
      return json({
        lists: lists.results,
        contacts: contacts.results,
        memberships: memberships.results,
        campaigns: campaigns.results,
        configured: configured(env),
      });
    }
    if (request.method !== "POST") return json({ message: "Not found." }, 404);
    const input = await readInput(request);
    if (path === "/lists") {
      const name = required(input.name, 100),
        slug = required(input.slug, 80);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        throw new BroadcastError(
          "Use lowercase letters, numbers and hyphens for the signup slug.",
        );
      if (input.id) {
        const result = await db
          .prepare("UPDATE broadcast_lists SET name=?,slug=? WHERE id=?")
          .bind(name, slug, required(input.id, 80))
          .run();
        if (!result.meta.changes)
          return json({ message: "List not found." }, 404);
      } else
        await db
          .prepare(
            "INSERT INTO broadcast_lists(id,name,slug,created_at) VALUES(?,?,?,?)",
          )
          .bind(crypto.randomUUID(), name, slug, Date.now())
          .run();
    } else if (path === "/contacts") {
      const email = emailAddress(input.email),
        name =
          typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
      await db
        .prepare(
          "INSERT INTO broadcast_contacts(id,email,name,created_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name",
        )
        .bind(crypto.randomUUID(), email, name, Date.now())
        .run();
    } else if (path === "/memberships") {
      const contact = required(input.contactId, 80);
      if (
        !Array.isArray(input.listIds) ||
        input.listIds.length > 100 ||
        !input.listIds.every((x) => typeof x === "string" && x.length <= 80)
      )
        throw new BroadcastError("Choose up to 100 lists.");
      const ids = [...new Set(input.listIds as string[])];
      if (!["add", "remove"].includes(String(input.action)) || !ids.length)
        throw new BroadcastError("Choose lists and an action.");
      const person = await db
        .prepare("SELECT tag FROM broadcast_contacts WHERE id=?")
        .bind(contact)
        .first<{ tag: string }>();
      if (!person) throw new BroadcastError("Contact not found.");
      if (input.action === "add" && input.consent !== true)
        throw new BroadcastError(
          "Confirm that this contact agreed to receive emails from the selected lists.",
        );
      if (input.action === "add" && person.tag)
        throw new BroadcastError(
          "Suppressed contacts cannot be added to lists.",
        );
      if (input.action === "add") {
        const optedOut = await db
          .prepare(
            `SELECT contact_id FROM broadcast_memberships WHERE contact_id=? AND state='unsubscribed' AND list_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`,
          )
          .bind(contact, ...ids)
          .first();
        if (optedOut)
          throw new BroadcastError(
            "This contact opted out of a selected list. They must confirm a new signup to rejoin it.",
          );
      }
      await db.batch(
        ids.map((id) =>
          input.action === "add"
            ? db
                .prepare(
                  "INSERT INTO broadcast_memberships(contact_id,list_id,state) SELECT ?,?,'active' WHERE EXISTS(SELECT 1 FROM broadcast_contacts WHERE id=? AND tag='') ON CONFLICT(contact_id,list_id) DO NOTHING",
                )
                .bind(contact, id, contact)
            : db
                .prepare(
                  "DELETE FROM broadcast_memberships WHERE contact_id=? AND list_id=? AND state='active'",
                )
                .bind(contact, id),
        ),
      );
    } else if (path === "/drafts") {
      const subject = required(input.subject, 200),
        body = required(input.body, 20000),
        list = required(input.listId, 80);
      if (/[\r\n]/.test(subject))
        throw new BroadcastError("Subject must be one line.");
      if (input.id) {
        const result = await db
          .prepare(
            "UPDATE broadcasts SET subject=?,body=?,list_id=? WHERE id=? AND state='draft'",
          )
          .bind(subject, body, list, required(input.id, 80))
          .run();
        if (!result.meta.changes)
          throw new BroadcastError("Only drafts can be edited.");
      } else {
        await db
          .prepare(
            "INSERT INTO broadcasts(id,list_id,subject,body,created_at,actor_id) VALUES(?,?,?,?,?,?)",
          )
          .bind(crypto.randomUUID(), list, subject, body, Date.now(), actor)
          .run();
      }
    } else if (path === "/send") {
      if (!configured(env))
        return json(
          {
            message:
              "Configure the broadcast stream, sender, origin and webhook secret before sending.",
          },
          503,
        );
      const id = required(input.id, 80);
      if (
        !(await db
          .prepare("SELECT id FROM broadcasts WHERE id=?")
          .bind(id)
          .first())
      )
        return json({ message: "Email not found." }, 404);
      // One atomic batch freezes the draft and snapshots the audience. Unique keys make concurrent clicks harmless.
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO broadcast_recipients(id,broadcast_id,contact_id,email)
    SELECT lower(hex(randomblob(16))),b.id,c.id,c.email FROM broadcasts b
    JOIN broadcast_memberships m ON m.list_id=b.list_id AND m.state='active'
    JOIN broadcast_contacts c ON c.id=m.contact_id AND c.tag=''
    WHERE b.id=? AND b.state='draft'`,
          )
          .bind(id),
        db
          .prepare(
            "UPDATE broadcasts SET state='queued',sent_at=?,actor_id=? WHERE id=? AND state='draft'",
          )
          .bind(Date.now(), actor, id),
      ]);
    } else return json({ message: "Not found." }, 404);
    return json({ success: true });
  } catch (error) {
    if (error instanceof BroadcastError)
      return json({ message: error.message }, 400);
    console.error(JSON.stringify({ event: "broadcast_admin_failed" }));
    return json(
      {
        message:
          "Unable to save. Check for a duplicate slug or missing list, then refresh.",
      },
      409,
    );
  }
}

export async function runBroadcastDelivery(
  env: BroadcastBindings,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM broadcast_confirmations WHERE expires_at < ?",
  )
    .bind(Date.now())
    .run();
  if (!configured(env)) return;
  const db = env.DB;
  await db
    .prepare(
      "UPDATE broadcast_recipients SET state='unknown' WHERE state='sending' AND attempted_at < ?",
    )
    .bind(Date.now() - 600000)
    .run();
  const rows = await db
    .prepare(
      `SELECT r.id,r.contact_id,r.email,b.subject,b.body,b.list_id FROM broadcast_recipients r
 JOIN broadcasts b ON b.id=r.broadcast_id WHERE r.state='pending' AND b.state='queued' ORDER BY b.sent_at,r.id LIMIT 10`,
    )
    .all<{
      id: string;
      contact_id: string;
      email: string;
      subject: string;
      body: string;
      list_id: string;
    }>();
  for (const row of rows.results) {
    const claim = await db
      .prepare(
        "UPDATE broadcast_recipients SET state='sending',attempted_at=? WHERE id=? AND state='pending'",
      )
      .bind(Date.now(), row.id)
      .run();
    if (!claim.meta.changes) continue;
    const eligible = await db
      .prepare(
        `SELECT c.id FROM broadcast_contacts c JOIN broadcast_memberships m ON m.contact_id=c.id
   WHERE c.id=? AND c.tag='' AND m.list_id=? AND m.state='active'`,
      )
      .bind(row.contact_id, row.list_id)
      .first();
    if (!eligible) {
      await db
        .prepare("UPDATE broadcast_recipients SET state='skipped' WHERE id=?")
        .bind(row.id)
        .run();
      continue;
    }
    try {
      const token = await signedToken(env, `preferences:${row.contact_id}`);
      const link = `${env.BROADCAST_ORIGIN}/email/preferences/${token}`;
      const oneClick = `${env.BROADCAST_ORIGIN}/email/unsubscribe/${await signedToken(env, `unsubscribe:${row.contact_id}:${row.list_id}`)}`;
      const custom = env.BROADCAST_UNSUBSCRIBE_MODE === "custom";
      const messageId = await sendPostmarkEmail(env, {
        from: env.BROADCAST_FROM_EMAIL!,
        to: row.email,
        subject: row.subject,
        text: `${row.body}\n\nManage your lists or unsubscribe: ${link}${custom ? "" : "\nUnsubscribe from all Pack broadcasts: {{{ pm:unsubscribe }}}"}`,
        html: `<div style="white-space:pre-wrap">${escape(row.body)}</div><p><a href="${escape(link)}">Manage lists or unsubscribe</a></p>${custom ? "" : '<p><a href="{{{ pm:unsubscribe }}}">Unsubscribe from all Pack broadcasts</a></p>'}`,
        stream: env.BROADCAST_STREAM!,
        metadata: { broadcastRecipient: row.id },
        ...(custom
          ? {
              headers: [
                { Name: "List-Unsubscribe", Value: `<${oneClick}>` },
                {
                  Name: "List-Unsubscribe-Post",
                  Value: "List-Unsubscribe=One-Click",
                },
              ],
            }
          : {}),
      });
      await db
        .prepare(
          "UPDATE broadcast_recipients SET state='accepted',message_id=? WHERE id=?",
        )
        .bind(messageId, row.id)
        .run();
    } catch {
      // Never retry an ambiguous provider request automatically.
      await db
        .prepare(
          "UPDATE broadcast_recipients SET state='unknown' WHERE id=? AND state='sending'",
        )
        .bind(row.id)
        .run();
    }
  }
  await db
    .prepare(
      "UPDATE broadcasts SET state='complete' WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM broadcast_recipients WHERE broadcast_id=broadcasts.id AND state IN ('pending','sending'))",
    )
    .run();
}

export async function handleBroadcastWebhook(
  request: Request,
  env: BroadcastBindings,
): Promise<Response> {
  if (request.method !== "POST")
    return json({ message: "Method not allowed." }, 405);
  if (
    !env.BROADCAST_WEBHOOK_SECRET ||
    !(await equalSecret(
      request.headers.get("X-Broadcast-Secret") ?? "",
      env.BROADCAST_WEBHOOK_SECRET,
    ))
  )
    return json({ message: "Unauthorized." }, 401);
  try {
    const input = await readInput(request);
    if (input.MessageStream !== env.BROADCAST_STREAM)
      return json({ success: true });
    const metadata = input.Metadata as Record<string, unknown> | undefined;
    const id =
      typeof metadata?.broadcastRecipient === "string"
        ? metadata.broadcastRecipient
        : "";
    const message = typeof input.MessageID === "string" ? input.MessageID : "";
    const row = await env.DB.prepare(
      "SELECT id,contact_id FROM broadcast_recipients WHERE (id=? OR message_id=?) AND email=?",
    )
      .bind(
        id,
        message,
        typeof input.Recipient === "string"
          ? input.Recipient.toLowerCase()
          : typeof input.Email === "string"
            ? input.Email.toLowerCase()
            : "",
      )
      .first<{ id: string; contact_id: string }>();
    if (
      input.RecordType === "SubscriptionChange" &&
      input.SuppressSending === true
    ) {
      const email = emailAddress(input.Recipient);
      const tag =
        input.SuppressionReason === "HardBounce"
          ? "suppressed"
          : input.SuppressionReason === "SpamComplaint"
            ? "complaint"
            : "unsubscribed";
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE broadcast_contacts SET tag=? WHERE email=? AND tag IN ('','suppressed')",
        ).bind(tag, email),
        env.DB.prepare(
          "UPDATE broadcast_memberships SET state='unsubscribed' WHERE contact_id IN (SELECT id FROM broadcast_contacts WHERE email=?) AND ? != 'suppressed'",
        ).bind(email, tag),
      ]);
    } else if (row) {
      const fields: Record<string, string> = {
        Delivery: "delivered",
        Open: "opened",
        Click: "clicked",
        Bounce: "bounced",
      };
      const field = fields[String(input.RecordType)];
      if (field)
        await env.DB.prepare(
          `UPDATE broadcast_recipients SET ${field}=1,message_id=COALESCE(message_id,?),state='accepted' WHERE id=?`,
        )
          .bind(message || null, row.id)
          .run();
      if (input.RecordType === "SpamComplaint")
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE broadcast_contacts SET tag='complaint' WHERE id=?",
          ).bind(row.contact_id),
          env.DB.prepare(
            "UPDATE broadcast_memberships SET state='unsubscribed' WHERE contact_id=?",
          ).bind(row.contact_id),
        ]);
    }
    return json({ success: true });
  } catch (error) {
    return json(
      {
        message:
          error instanceof BroadcastError
            ? error.message
            : "Webhook processing failed.",
      },
      error instanceof BroadcastError ? 400 : 500,
    );
  }
}
