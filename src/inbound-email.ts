import type { Bindings } from "@sonicjs-cms/core";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { convert } from "html-to-text";
import { BroadcastError, json, readInput } from "./broadcasts";

export type InboundBindings = Bindings &
  Pick<Env, "INBOUND_BUCKET"> & {
    INBOUND_WEBHOOK_SECRET?: string;
  };
export const INBOX_API = "/api/inbox/v1";
const states = ["new", "reviewed", "archived", "spam"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const join =
  "FROM inbound_emails e LEFT JOIN broadcast_contacts c ON c.email=e.sender COLLATE NOCASE";
const columns = "e.*,c.id AS contact_id,c.name AS contact_name";
type EmailRow = {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  revision: number;
};
type Attachment = {
  Name: string;
  Content: string;
  ContentType: string;
  ContentLength: number;
};
type Payload = {
  MessageID: string;
  MessageStream: string;
  OriginalRecipient: string;
  FromFull: { Email: string; Name: string };
  Subject: string;
  Date: string;
  TextBody: string;
  HtmlBody: string;
  To: string;
  Cc: string;
  Bcc: string;
  ReplyTo: string;
  Attachments: Attachment[];
};
class InputError extends Error {}
function field(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new InputError("Invalid email payload.");
  return value;
}
function address(value: unknown): string {
  const result = field(value, 254, true).trim().toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result))
    throw new InputError("Invalid email address.");
  return result;
}
export function parseInbound(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputError("Invalid email payload.");
  const p = value as Record<string, unknown>;
  const from = p.FromFull as Record<string, unknown> | undefined;
  const id = field(p.MessageID, 36, true).toLowerCase();
  if (!uuid.test(id) || p.MessageStream !== "inbound")
    throw new InputError("Invalid message identity or stream.");
  const recipient = address(p.OriginalRecipient);
  if (!recipient.endsWith("@macon170.com"))
    throw new InputError("Recipient must be at macon170.com.");
  if (!Array.isArray(p.Attachments) || p.Attachments.length > 100)
    throw new InputError("Invalid attachments.");
  const attachments = p.Attachments.map((item: unknown): Attachment => {
    if (!item || typeof item !== "object")
      throw new InputError("Invalid attachment.");
    const a = item as Record<string, unknown>;
    const content = field(a.Content, 20 * 1024 * 1024);
    if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content))
      throw new InputError("Invalid attachment encoding.");
    const length =
      (content.length / 4) * 3 -
      (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
    if (a.ContentLength !== length)
      throw new InputError("Invalid attachment length.");
    return {
      Name: field(a.Name, 512, true),
      Content: content,
      ContentType: field(a.ContentType, 200),
      ContentLength: length,
    };
  });
  return {
    MessageID: id,
    MessageStream: "inbound",
    OriginalRecipient: recipient,
    FromFull: { Email: address(from?.Email), Name: field(from?.Name, 1000) },
    Subject: field(p.Subject, 4000),
    Date: field(p.Date, 200),
    TextBody: field(p.TextBody, 10 * 1024 * 1024),
    HtmlBody: field(p.HtmlBody, 10 * 1024 * 1024),
    To: field(p.To, 10000),
    Cc: field(p.Cc, 10000),
    Bcc: field(p.Bcc, 10000),
    ReplyTo: field(p.ReplyTo, 10000),
    Attachments: attachments,
  };
}
async function boundedBody(request: Request): Promise<string> {
  const limit = 20 * 1024 * 1024;
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new InputError("Email exceeds 20 MiB webhook limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Missing payload.");
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new InputError("Email exceeds 20 MiB webhook limit.");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}
export async function handleInboundWebhook(
  request: Request,
  env: InboundBindings,
): Promise<Response> {
  if (request.method !== "POST")
    return json({ message: "Method not allowed." }, 405);
  if (!env.INBOUND_WEBHOOK_SECRET || !env.INBOUND_BUCKET)
    return json({ message: "Inbound email is not configured." }, 503);
  // Postmark supports Basic authentication in its inbound webhook URL.
  const expected = new TextEncoder().encode(
    "Basic " + btoa("postmark:" + env.INBOUND_WEBHOOK_SECRET),
  );
  const actual = new TextEncoder().encode(
    request.headers.get("Authorization") ?? "",
  );
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return json({ message: "Unauthorized." }, 401);
  try {
    if (!request.headers.get("Content-Type")?.includes("application/json"))
      throw new InputError("JSON required.");
    let value: unknown;
    try {
      value = JSON.parse(await boundedBody(request));
    } catch (e) {
      if (e instanceof InputError) throw e;
      throw new InputError("Invalid JSON.");
    }
    const p = parseInbound(value);
    const existing = await env.DB.prepare(
      "SELECT id FROM inbound_emails WHERE id=?",
    )
      .bind(p.MessageID)
      .first();
    if (existing) return json({ success: true });
    // Store durable content before acknowledging. Deterministic keys and INSERT OR
    // IGNORE make retries/concurrent deliveries safe without resetting review status.
    await env.INBOUND_BUCKET.put("messages/" + p.MessageID, JSON.stringify(p), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO inbound_emails(id,sender,sender_name,recipient,subject,sent_at,received_at,attachment_count)
      VALUES(?,?,?,?,?,?,?,?)`,
    )
      .bind(
        p.MessageID,
        p.FromFull.Email,
        p.FromFull.Name,
        p.OriginalRecipient,
        p.Subject,
        p.Date,
        Date.now(),
        p.Attachments.length,
      )
      .run();
    return json({ success: true });
  } catch (e) {
    if (e instanceof InputError) return json({ message: e.message }, 422);
    console.error(JSON.stringify({ event: "inbound_storage_failed" }));
    return json({ message: "Storage unavailable. Retry delivery." }, 503);
  }
}
export async function handleInboxAdmin(
  request: Request,
  env: InboundBindings,
  actorId: string,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname.slice(INBOX_API.length);
  try {
    if (request.method === "GET" && (path === "" || path === "/")) {
      const q = url.searchParams,
        conditions: string[] = [],
        args: (string | number)[] = [];
      const status = q.get("status");
      if (status) {
        if (!states.includes(status)) throw new InputError("Invalid status.");
        conditions.push("e.status=?");
        args.push(status);
      }
      for (const [key, column] of [
        ["sender", "e.sender"],
        ["recipient", "e.recipient"],
        ["contactId", "c.id"],
      ] as const) {
        const value = q.get(key);
        if (value) {
          conditions.push(column + "=?");
          args.push(
            key === "contactId"
              ? field(value, 254)
              : field(value, 254).toLowerCase(),
          );
        }
      }
      if (q.get("q")) {
        conditions.push(
          "(instr(lower(e.subject),lower(?))>0 OR instr(lower(e.sender),lower(?))>0 OR instr(lower(e.sender_name),lower(?))>0)",
        );
        const search = field(q.get("q"), 200);
        args.push(search, search, search);
      }
      for (const [key, op] of [
        ["after", ">="],
        ["before", "<"],
      ] as const) {
        if (q.get(key)) {
          const date = Date.parse(q.get(key)!);
          if (!Number.isFinite(date)) throw new InputError("Invalid date.");
          conditions.push("e.received_at" + op + "?");
          args.push(date);
        }
      }
      const sorts: Record<string, string> = {
        received_at: "e.received_at",
        sender: "e.sender",
        subject: "e.subject",
        recipient: "e.recipient",
      };
      const sort = q.get("sort") ?? "received_at",
        direction = q.get("direction") ?? "desc";
      if (!Object.hasOwn(sorts, sort) || !["asc", "desc"].includes(direction))
        throw new InputError("Invalid sorting.");
      const page = Number(q.get("page") ?? "1");
      if (!Number.isInteger(page) || page < 1 || page > 100000)
        throw new InputError("Invalid page.");
      const where = conditions.length
        ? " WHERE " + conditions.join(" AND ")
        : "";
      const rows = await env.DB.prepare(
        `SELECT ${columns} ${join}${where} ORDER BY ${sorts[sort]} ${direction},e.id ASC LIMIT 26 OFFSET ?`,
      )
        .bind(...args, (page - 1) * 25)
        .all();
      let contact = null;
      if (q.get("contactId"))
        contact = await env.DB.prepare(
          "SELECT id,email,name,tag FROM broadcast_contacts WHERE id=?",
        )
          .bind(q.get("contactId"))
          .first();
      return json({
        emails: rows.results.slice(0, 25),
        page,
        hasMore: rows.results.length > 25,
        contact,
      });
    }
    const match = /^\/([0-9a-f-]+)(?:\/attachments\/(\d+))?$/.exec(path);
    if (!match || !uuid.test(match[1]!))
      return json({ message: "Not found." }, 404);
    const row = await env.DB.prepare(`SELECT ${columns} ${join} WHERE e.id=?`)
      .bind(match[1])
      .first<EmailRow>();
    if (!row) return json({ message: "Email not found." }, 404);
    if (request.method === "GET") {
      const object = await env.INBOUND_BUCKET.get("messages/" + row.id);
      if (!object)
        return json({ message: "Message content unavailable." }, 503);
      const p = await object.json<Payload>();
      if (match[2] !== undefined) {
        const attachment = p.Attachments[Number(match[2])];
        if (!attachment) return json({ message: "Attachment not found." }, 404);
        return new Response(Buffer.from(attachment.Content, "base64"), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition":
              "attachment; filename*=UTF-8''" +
              encodeURIComponent(attachment.Name).replace(/'/g, "%27"),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          },
        });
      }
      // Never return active HTML or remote tracking images to the inbox/LLM.
      return json({
        email: row,
        content: {
          text: p.TextBody || convert(p.HtmlBody, { wordwrap: false }),
          to: p.To,
          cc: p.Cc,
          bcc: p.Bcc,
          replyTo: p.ReplyTo,
          attachments: p.Attachments.map((a, i) => ({
            name: a.Name,
            size: a.ContentLength,
            contentType: a.ContentType,
            download: INBOX_API + "/" + row.id + "/attachments/" + i,
          })),
        },
      });
    }
    if (request.method === "PATCH" && match[2] === undefined) {
      const input = await readInput(request);
      if (
        !states.includes(String(input.status)) ||
        !Number.isInteger(input.expectedRevision)
      )
        throw new InputError("Status and current expectedRevision required.");
      const result = await env.DB.batch([
        env.DB.prepare(
          "UPDATE inbound_emails SET status=?,revision=revision+1 WHERE id=? AND revision=?",
        ).bind(input.status, row.id, input.expectedRevision),
        env.DB.prepare(
          "INSERT INTO inbound_audit(id,email_id,actor_id,status,created_at) SELECT ?,?,?,?,? WHERE changes()=1",
        ).bind(crypto.randomUUID(), row.id, actorId, input.status, Date.now()),
      ]);
      if (result[0]!.meta.changes !== 1)
        return json(
          { message: "Email changed. Refresh before updating." },
          409,
        );
      return json({ success: true });
    }
    return json({ message: "Method not allowed." }, 405);
  } catch (e) {
    if (e instanceof InputError || e instanceof BroadcastError)
      return json({ message: e.message }, 400);
    console.error(JSON.stringify({ event: "inbox_request_failed" }));
    return json({ message: "Inbox unavailable." }, 503);
  }
}
