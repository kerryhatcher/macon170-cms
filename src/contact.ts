import type { Bindings } from "@sonicjs-cms/core";

export const CONTACT_FORM_ID = "default-contact-form";
export const CONTACT_FORM_NAME = "contact";
export const CONTACT_FORM_VERSION = "pack-contact-v1";
export const CONTACT_QUEUE_PATH =
  "/admin/forms/default-contact-form/submissions";
export const CONTACT_API_BASE = "/api/contact-admin/v1/submissions";
export const CONTACT_RETENTION_DAYS = 365;

const CONTACT_COLLECTION_ID = "collection-form-contact";
const SYSTEM_FORM_USER_ID = "system-form-submission";
const MAX_FORM_BYTES = 24_000;
const PAGE_SIZE = 25;

export const CONTACT_STATUSES = [
  "pending",
  "reviewed",
  "approved",
  "spam",
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  pending: "New",
  reviewed: "In progress",
  approved: "Resolved",
  spam: "Spam",
};

export const ALLOWED_TOPICS = [
  "Planning a first visit",
  "Calendar or event detail",
  "Finding my child’s den",
  "Volunteering",
  "Website or privacy question",
  "Something else",
] as const;

export const ALLOWED_GRADES = [
  "",
  "Kindergarten",
  "1st grade",
  "2nd grade",
  "3rd grade",
  "4th grade",
  "5th grade",
] as const;

type ContactRateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type ContactBindings = Bindings & {
  APP_VERSION?: string;
  CONTACT_RATE_LIMITER: ContactRateLimiter;
  PUBLIC_SITE_ORIGIN?: string;
  TURNSTILE_EXPECTED_ACTION?: string;
  TURNSTILE_EXPECTED_HOSTNAMES?: string;
  TURNSTILE_SECRET?: string;
};

export type ContactInput = {
  parentName: string;
  email: string;
  phone: string | null;
  childGrade: string | null;
  topic: string;
  message: string;
};

type TurnstileResult = {
  success: boolean;
  hostname?: string;
  action?: string;
  challenge_ts?: string;
  "error-codes"?: string[];
};

type FormRow = {
  id: string;
  name: string;
  display_name: string;
};

type SubmissionRow = {
  id: string;
  status: ContactStatus;
  submission_number: number | null;
  submission_data: string;
  submitted_at: number;
  updated_at: number;
  country_code: string | null;
  source_path: string | null;
  last_viewed_at: number | null;
};

export class ContactRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | "validation"
      | "rate_limit"
      | "security"
      | "temporary"
      | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export function isContactSubmissionPath(pathname: string): boolean {
  return (
    pathname === "/api/forms/contact/submit" ||
    pathname === "/api/forms/default-contact-form/submit"
  );
}

export async function handleContactSubmission(
  request: Request,
  env: ContactBindings,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const allowedOrigin = configuredPublicOrigin(env);
  const wantsJson = isJsonRequest(request);

  try {
    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) {
        throw new ContactRequestError(
          403,
          "security",
          "Request origin rejected.",
        );
      }
      return publicCors(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Max-Age": "600",
            "Cache-Control": "no-store",
          },
        }),
        origin,
      );
    }
    if (request.method !== "POST") {
      return contactErrorResponse(
        request,
        new ContactRequestError(
          405,
          "validation",
          "Method not allowed.",
        ),
        allowedOrigin,
      );
    }
    if (origin !== allowedOrigin) {
      throw new ContactRequestError(
        403,
        "security",
        "Request origin rejected.",
      );
    }

    const raw = await readContactBody(request);
    if (clean(raw.website, 100)) {
      return contactSuccessResponse(request, null, null, allowedOrigin);
    }

    const input = validateContactInput(raw);
    const token = clean(
      raw["cf-turnstile-response"] ?? raw.turnstile,
      2_048,
    );
    if (!token) {
      throw new ContactRequestError(
        400,
        "security",
        "Complete the security check before submitting.",
      );
    }
    const rateKey = await stableHash(
      `${input.email}|${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    );
    const rateLimit = await env.CONTACT_RATE_LIMITER.limit({ key: rateKey });
    if (!rateLimit.success) {
      throw new ContactRequestError(
        429,
        "rate_limit",
        "Too many messages were submitted. Please wait a minute and try again.",
      );
    }

    await verifyTurnstile(token, request, env, fetchImpl);
    const form = await findContactForm(env.DB);
    if (!form) {
      throw new ContactRequestError(
        503,
        "temporary",
        "The contact form is temporarily unavailable.",
      );
    }

    const submissionId = crypto.randomUUID();
    const contentId = crypto.randomUUID();
    const now = Date.now();
    const submissionData = JSON.stringify(input);
    const countryCode = truncate(
      request.headers.get("CF-IPCountry"),
      2,
    )?.toUpperCase();
    const sourcePath = "/contact/";
    const contentData = JSON.stringify({
      title: input.parentName,
      ...input,
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO content (
           id, collection_id, slug, title, data, status, author_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      ).bind(
        contentId,
        CONTACT_COLLECTION_ID,
        `submission-${submissionId}`,
        input.parentName,
        contentData,
        SYSTEM_FORM_USER_ID,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO form_submissions (
           id, form_id, submission_data, status, user_id, user_email,
           ip_address, user_agent, referrer, submitted_at, updated_at,
           content_id, source_path, country_code
         ) VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        submissionId,
        form.id,
        submissionData,
        input.email,
        truncate(request.headers.get("CF-Connecting-IP"), 64),
        truncate(request.headers.get("User-Agent"), 500),
        truncate(request.headers.get("Referer"), 500),
        now,
        now,
        contentId,
        sourcePath,
        countryCode,
      ),
    ]);

    console.log(
      JSON.stringify({
        event: "contact_created",
        submissionId,
        topic: input.topic,
        countryCode,
      }),
    );
    return contactSuccessResponse(
      request,
      submissionId,
      contentId,
      allowedOrigin,
    );
  } catch (error) {
    const safeError =
      error instanceof ContactRequestError
        ? error
        : new ContactRequestError(
            503,
            "temporary",
            "The contact service is temporarily unavailable.",
          );
    if (!(error instanceof ContactRequestError)) {
      console.error(
        JSON.stringify({
          event: "contact_submission_failed",
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    const response = contactErrorResponse(request, safeError, allowedOrigin);
    return wantsJson
      ? publicCors(response, origin === allowedOrigin ? origin : null)
      : response;
  }
}

export function validateContactInput(
  raw: Record<string, unknown>,
): ContactInput {
  const parentName = required(
    raw.parentName,
    "Parent or guardian name",
    2,
    120,
  );
  const email = required(raw.email, "Email", 5, 254).toLowerCase();
  const phone = optional(raw.phone, 40);
  const childGrade = optional(raw.childGrade, 30);
  const topic = required(raw.topic, "Topic", 2, 80);
  const message = required(raw.message, "Question", 10, 4_000);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ContactRequestError(
      400,
      "validation",
      "Enter a valid parent or guardian email address.",
    );
  }
  if (!(ALLOWED_TOPICS as readonly string[]).includes(topic)) {
    throw new ContactRequestError(
      400,
      "validation",
      "Choose a valid topic.",
    );
  }
  if (
    !(ALLOWED_GRADES as readonly string[]).includes(childGrade ?? "")
  ) {
    throw new ContactRequestError(
      400,
      "validation",
      "Choose a valid grade.",
    );
  }

  return { parentName, email, phone, childGrade, topic, message };
}

export async function listContactSubmissions(
  request: Request,
  env: ContactBindings,
): Promise<Response> {
  const url = new URL(request.url);
  const status = parseStatus(url.searchParams.get("status"));
  const page = Math.max(
    1,
    Math.min(
      1_000,
      Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
    ),
  );
  const offset = (page - 1) * PAGE_SIZE;
  const where = status
    ? "WHERE form_id = ? AND status = ?"
    : "WHERE form_id = ?";
  const statement = env.DB.prepare(
    `SELECT id, status, submission_number, submission_data, submitted_at,
            updated_at, country_code, source_path, last_viewed_at
     FROM form_submissions
     ${where}
     ORDER BY submitted_at DESC
     LIMIT ? OFFSET ?`,
  );
  const result = status
    ? await statement
        .bind(CONTACT_FORM_ID, status, PAGE_SIZE, offset)
        .all<SubmissionRow>()
    : await statement
        .bind(CONTACT_FORM_ID, PAGE_SIZE, offset)
        .all<SubmissionRow>();
  return adminJson({
    version: CONTACT_FORM_VERSION,
    submissions: result.results.map(publicSubmission),
    page,
    hasMore: result.results.length === PAGE_SIZE,
  });
}

export async function getContactSubmission(
  id: string,
  env: ContactBindings,
  actorId: string,
): Promise<Response> {
  const submission = await env.DB.prepare(
    `SELECT id, status, submission_number, submission_data, submitted_at,
            updated_at, country_code, source_path, last_viewed_at
     FROM form_submissions
     WHERE id = ? AND form_id = ?`,
  )
    .bind(id, CONTACT_FORM_ID)
    .first<SubmissionRow>();
  if (!submission) {
    return adminError(404, "not_found", "Submission not found.");
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE form_submissions SET last_viewed_at = ? WHERE id = ?",
    ).bind(now, id),
    env.DB.prepare(
      `INSERT INTO contact_submission_audit
       (id, submission_id, actor_id, action, created_at)
       VALUES (?, ?, ?, 'viewed', ?)`,
    ).bind(crypto.randomUUID(), id, actorId, now),
  ]);
  return adminJson({
    version: CONTACT_FORM_VERSION,
    submission: publicSubmission({ ...submission, last_viewed_at: now }),
  });
}

export async function updateContactSubmission(
  request: Request,
  id: string,
  env: ContactBindings,
  actorId: string,
): Promise<Response> {
  const payload = await readSmallJson(request, 2_000);
  const nextStatus = parseStatus(
    typeof payload.status === "string" ? payload.status : null,
  );
  if (!nextStatus) {
    return adminError(
      400,
      "invalid_status",
      "Choose a valid submission status.",
    );
  }
  const current = await env.DB.prepare(
    `SELECT status, content_id FROM form_submissions
     WHERE id = ? AND form_id = ?`,
  )
    .bind(id, CONTACT_FORM_ID)
    .first<{ status: ContactStatus; content_id: string | null }>();
  if (!current) {
    return adminError(404, "not_found", "Submission not found.");
  }

  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `UPDATE form_submissions
       SET status = ?, is_spam = ?, reviewed_by = ?, reviewed_at = ?,
           updated_at = ?
       WHERE id = ?`,
    ).bind(
      nextStatus,
      nextStatus === "spam" ? 1 : 0,
      actorId,
      now,
      now,
      id,
    ),
    env.DB.prepare(
      `INSERT INTO contact_submission_audit
       (id, submission_id, actor_id, action, detail, created_at)
       VALUES (?, ?, ?, 'status_changed', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      actorId,
      `${current.status} -> ${nextStatus}`,
      now,
    ),
  ];
  if (current.content_id) {
    statements.push(
      env.DB.prepare(
        "UPDATE content SET status = ?, updated_at = ? WHERE id = ?",
      ).bind(nextStatus === "spam" ? "archived" : "draft", now, current.content_id),
    );
  }
  await env.DB.batch(statements);
  return adminJson({
    version: CONTACT_FORM_VERSION,
    status: nextStatus,
    statusLabel: CONTACT_STATUS_LABELS[nextStatus],
  });
}

export async function runContactRetention(
  env: ContactBindings,
): Promise<void> {
  const cutoff = Date.now() - CONTACT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM contact_submission_audit
       WHERE submission_id IN (
         SELECT id FROM form_submissions
         WHERE form_id = ? AND submitted_at < ?
       )`,
    ).bind(CONTACT_FORM_ID, cutoff),
    env.DB.prepare(
      `DELETE FROM form_submissions
       WHERE form_id = ? AND submitted_at < ?`,
    ).bind(CONTACT_FORM_ID, cutoff),
    env.DB
      .prepare(
      `UPDATE forms
       SET submission_count = (
         SELECT COUNT(*) FROM form_submissions WHERE form_id = ?
       ), updated_at = ?
       WHERE id = ?`,
      )
      .bind(CONTACT_FORM_ID, Date.now(), CONTACT_FORM_ID),
  ]);

  console.log(
    JSON.stringify({
      event: "contact_retention_cleanup",
      retentionDays: CONTACT_RETENTION_DAYS,
      deleted: results[1]?.meta?.changes ?? 0,
    }),
  );
}

async function findContactForm(db: D1Database): Promise<FormRow | null> {
  return db
    .prepare(
      `SELECT id, name, display_name FROM forms
       WHERE id = ? AND name = ? AND is_active = 1 AND is_public = 1`,
    )
    .bind(CONTACT_FORM_ID, CONTACT_FORM_NAME)
    .first<FormRow>();
}

async function verifyTurnstile(
  token: string,
  request: Request,
  env: ContactBindings,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!env.TURNSTILE_SECRET) {
    throw new ContactRequestError(
      503,
      "temporary",
      "The security check is temporarily unavailable.",
    );
  }
  const payload = new FormData();
  payload.set("secret", env.TURNSTILE_SECRET);
  payload.set("response", token);
  payload.set("idempotency_key", crypto.randomUUID());
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) payload.set("remoteip", ip);

  let response: Response;
  try {
    response = await fetchImpl(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: payload },
    );
  } catch {
    throw new ContactRequestError(
      503,
      "temporary",
      "The security check is temporarily unavailable.",
    );
  }
  if (!response.ok) {
    throw new ContactRequestError(
      503,
      "temporary",
      "The security check is temporarily unavailable.",
    );
  }

  let result: TurnstileResult;
  try {
    result = (await response.json()) as TurnstileResult;
  } catch {
    throw new ContactRequestError(
      503,
      "temporary",
      "The security check is temporarily unavailable.",
    );
  }
  if (!result.success) {
    console.warn(
      JSON.stringify({
        event: "turnstile_rejected",
        codes: result["error-codes"] ?? [],
      }),
    );
    throw new ContactRequestError(
      400,
      "security",
      "The security check expired or failed. Refresh the page and try again.",
    );
  }

  if (env.ENVIRONMENT !== "development") {
    const hostnames = new Set(
      (env.TURNSTILE_EXPECTED_HOSTNAMES ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    if (!result.hostname || !hostnames.has(result.hostname)) {
      throw new ContactRequestError(
        400,
        "security",
        "The security check was issued for a different website.",
      );
    }
    const expectedAction =
      env.TURNSTILE_EXPECTED_ACTION ?? "turnstile-spin-v2";
    if (!result.action || result.action !== expectedAction) {
      throw new ContactRequestError(
        400,
        "security",
        "The security check did not match this form.",
      );
    }
  }
}

async function readContactBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(request, MAX_FORM_BYTES);
  const contentType = (
    request.headers.get("Content-Type") ?? ""
  ).toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not an object");
      }
      const record = value as Record<string, unknown>;
      const data = record.data;
      return data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : record;
    } catch {
      throw new ContactRequestError(
        400,
        "validation",
        "The request body was not valid JSON.",
      );
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(
      new URLSearchParams(new TextDecoder().decode(bytes)).entries(),
    );
  }
  if (contentType.includes("multipart/form-data")) {
    const form = await new Response(bytes, {
      headers: { "Content-Type": contentType },
    }).formData();
    return Object.fromEntries(form.entries());
  }
  throw new ContactRequestError(
    415,
    "validation",
    "Submit the form as HTML form data or JSON.",
  );
}

async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  const rawLength = request.headers.get("Content-Length");
  if (rawLength) {
    const length = Number.parseInt(rawLength, 10);
    if (!Number.isFinite(length) || length < 0 || length > maximum) {
      throw new ContactRequestError(
        413,
        "validation",
        "That message is too large.",
      );
    }
  }
  if (!request.body) {
    throw new ContactRequestError(
      400,
      "validation",
      "The form was empty.",
    );
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel("Contact form body exceeded limit");
      throw new ContactRequestError(
        413,
        "validation",
        "That message is too large.",
      );
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readSmallJson(
  request: Request,
  maximum: number,
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(request, maximum);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ContactRequestError(
      400,
      "validation",
      "The request body was not valid JSON.",
    );
  }
}

function publicSubmission(row: SubmissionRow): Record<string, unknown> {
  const data = JSON.parse(row.submission_data) as ContactInput;
  return {
    id: row.id,
    number: row.submission_number,
    status: row.status,
    statusLabel: CONTACT_STATUS_LABELS[row.status],
    parentName: data.parentName,
    email: data.email,
    phone: data.phone,
    childGrade: data.childGrade,
    topic: data.topic,
    message: data.message,
    countryCode: row.country_code,
    sourcePath: row.source_path,
    submittedAt: new Date(row.submitted_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastViewedAt: row.last_viewed_at
      ? new Date(row.last_viewed_at).toISOString()
      : null,
  };
}

function required(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  const result = clean(value, maximum);
  if (result.length < minimum) {
    throw new ContactRequestError(
      400,
      "validation",
      `${label} is required.`,
    );
  }
  return result;
}

function optional(value: unknown, maximum: number): string | null {
  const result = clean(value, maximum);
  return result || null;
}

function clean(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (normalized.length > maximum) {
    throw new ContactRequestError(
      400,
      "validation",
      "One or more fields are too long.",
    );
  }
  return normalized;
}

function truncate(value: string | null, maximum: number): string | null {
  if (!value) return null;
  return value.slice(0, maximum);
}

function parseStatus(value: string | null): ContactStatus | null {
  return value &&
    (CONTACT_STATUSES as readonly string[]).includes(value)
    ? (value as ContactStatus)
    : null;
}

function configuredPublicOrigin(env: ContactBindings): string {
  return env.PUBLIC_SITE_ORIGIN ?? "https://www.macon170.com";
}

function isJsonRequest(request: Request): boolean {
  return (request.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .includes("application/json");
}

function contactSuccessResponse(
  request: Request,
  submissionId: string | null,
  contentId: string | null,
  publicOrigin: string,
): Response {
  if (isJsonRequest(request)) {
    return publicCors(
      Response.json(
        {
          success: true,
          ...(submissionId ? { submissionId, contentId } : {}),
          message: "Form submitted successfully.",
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      ),
      request.headers.get("Origin"),
    );
  }
  return Response.redirect(
    `${publicOrigin}/contact/?submitted=success#contact-form`,
    303,
  );
}

function contactErrorResponse(
  request: Request,
  error: ContactRequestError,
  publicOrigin: string,
): Response {
  if (isJsonRequest(request)) {
    return Response.json(
      {
        success: false,
        error: { code: error.code, message: error.message },
      },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const code = error.code === "not_found" ? "temporary" : error.code;
  return Response.redirect(
    `${publicOrigin}/contact/?error=${encodeURIComponent(code)}#contact-form`,
    303,
  );
}

function publicCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function adminJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function adminError(
  status: number,
  code: string,
  message: string,
): Response {
  return adminJson({ error: { code, message } }, status);
}

async function stableHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
