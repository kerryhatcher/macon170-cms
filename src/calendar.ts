import type { Bindings } from "@sonicjs-cms/core";

export const CALENDAR_PERMISSION = "calendar.manage";
export const CALENDAR_VERSION = "v1";
export const CALENDAR_TIMEZONE = "America/New_York" as const;

export type CalendarPublicationState = "draft" | "published" | "archived";
export type CalendarEventStatus = "scheduled" | "tentative" | "cancelled";
export type CalendarCategory = "pack" | "den" | "family";
export type CalendarMilestone =
  | "lego-derby"
  | "fall-camp"
  | "pinewood-derby"
  | "blue-gold";

export type CalendarEvent = {
  id: string;
  revision: number;
  slug: string;
  publicationState: CalendarPublicationState;
  eventStatus: CalendarEventStatus;
  category: CalendarCategory;
  title: string;
  summary: string;
  description: string;
  startsAt: string;
  endsAt: string | null;
  timezone: typeof CALENDAR_TIMEZONE;
  locationName: string | null;
  address: string | null;
  audience: string;
  whatToBring: string | null;
  cost: string | null;
  registrationUrl: string | null;
  milestone: CalendarMilestone | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type CalendarEventInput = Omit<
  CalendarEvent,
  | "id"
  | "revision"
  | "publicationState"
  | "createdAt"
  | "updatedAt"
  | "publishedAt"
>;

export type CalendarBindings = Bindings & {
  APP_VERSION?: string;
  JWT_SECRET?: string;
  ENVIRONMENT?: string;
};

type CalendarRow = {
  id: string;
  revision: number;
  slug: string;
  publication_state: CalendarPublicationState;
  event_status: CalendarEventStatus;
  category: CalendarCategory;
  title: string;
  summary: string;
  description: string;
  starts_at: string;
  ends_at: string | null;
  timezone: typeof CALENDAR_TIMEZONE;
  location_name: string | null;
  address: string | null;
  audience: string;
  what_to_bring: string | null;
  cost: string | null;
  registration_url: string | null;
  milestone: CalendarMilestone | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

const categories = new Set<CalendarCategory>(["pack", "den", "family"]);
const statuses = new Set<CalendarEventStatus>([
  "scheduled",
  "tentative",
  "cancelled",
]);
const milestones = new Set<CalendarMilestone>([
  "lego-derby",
  "fall-camp",
  "pinewood-derby",
  "blue-gold",
]);
const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export class CalendarConflictError extends Error {}
export class CalendarNotFoundError extends Error {}

export function validateCalendarInput(
  input: Record<string, unknown>,
): CalendarEventInput {
  const text = (key: string, min: number, max: number): string => {
    const value = input[key];
    if (
      typeof value !== "string" ||
      value.trim().length < min ||
      value.trim().length > max
    ) {
      throw new Error(`Invalid ${key}`);
    }
    return value.trim();
  };
  const optional = (key: string, max: number): string | null => {
    const value = input[key];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || value.trim().length > max) {
      throw new Error(`Invalid ${key}`);
    }
    return value.trim() || null;
  };
  const instant = (key: string): string => {
    const value = input[key];
    if (
      typeof value !== "string" ||
      !instantPattern.test(value) ||
      Number.isNaN(Date.parse(value))
    ) {
      throw new Error(`Invalid ${key}`);
    }
    return new Date(value).toISOString();
  };

  const slug = text("slug", 2, 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Invalid slug");
  }
  const startsAt = instant("startsAt");
  const endsAt =
    input.endsAt === null || input.endsAt === undefined || input.endsAt === ""
      ? null
      : instant("endsAt");
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new Error("End date must be after the start date");
  }
  if (input.timezone !== CALENDAR_TIMEZONE) {
    throw new Error(`Pack 170 events use ${CALENDAR_TIMEZONE}`);
  }

  const category = text("category", 1, 20) as CalendarCategory;
  if (!categories.has(category)) throw new Error("Invalid category");
  const eventStatus = text("eventStatus", 1, 20) as CalendarEventStatus;
  if (!statuses.has(eventStatus)) throw new Error("Invalid eventStatus");

  const registrationUrl = optional("registrationUrl", 2000);
  if (registrationUrl) {
    let parsed: URL;
    try {
      parsed = new URL(registrationUrl);
    } catch {
      throw new Error("Invalid registrationUrl");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Registration URL must use HTTP or HTTPS");
    }
  }
  const milestone = optional("milestone", 80) as CalendarMilestone | null;
  if (milestone && !milestones.has(milestone)) {
    throw new Error("Invalid milestone");
  }

  return {
    slug,
    title: text("title", 3, 160),
    summary: text("summary", 10, 500),
    description: text("description", 10, 8000),
    category,
    eventStatus,
    startsAt,
    endsAt,
    timezone: CALENDAR_TIMEZONE,
    locationName: optional("locationName", 200),
    address: optional("address", 300),
    audience: text("audience", 2, 300),
    whatToBring: optional("whatToBring", 2000),
    cost: optional("cost", 500),
    registrationUrl,
    milestone,
  };
}

export function rowToEvent(row: CalendarRow): CalendarEvent {
  return {
    id: row.id,
    revision: row.revision,
    slug: row.slug,
    publicationState: row.publication_state,
    eventStatus: row.event_status,
    category: row.category,
    title: row.title,
    summary: row.summary,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    locationName: row.location_name,
    address: row.address,
    audience: row.audience,
    whatToBring: row.what_to_bring,
    cost: row.cost,
    registrationUrl: row.registration_url,
    milestone: row.milestone,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    publishedAt:
      row.published_at === null
        ? null
        : new Date(row.published_at).toISOString(),
  };
}

const selectColumns = `
  id, revision, slug, publication_state, event_status, category, title,
  summary, description, starts_at, ends_at, timezone, location_name, address,
  audience, what_to_bring, cost, registration_url, milestone, created_at,
  updated_at, published_at
`;

export async function listCalendarEvents(
  env: CalendarBindings,
  publishedOnly: boolean,
  upcomingOnly = false,
): Promise<CalendarEvent[]> {
  const conditions = [
    ...(publishedOnly ? ["publication_state = 'published'"] : []),
    ...(upcomingOnly ? ["COALESCE(ends_at, starts_at) >= ?"] : []),
  ];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = env.DB.prepare(
    `SELECT ${selectColumns} FROM calendar_events ${where} ORDER BY starts_at ASC, slug ASC`,
  );
  const rows = upcomingOnly
    ? await statement.bind(new Date().toISOString()).all<CalendarRow>()
    : await statement.all<CalendarRow>();
  return rows.results.map(rowToEvent);
}

export async function getCalendarEvent(
  env: CalendarBindings,
  key: string,
  publishedOnly: boolean,
): Promise<CalendarEvent | null> {
  const field = publishedOnly ? "slug" : "id";
  const published = publishedOnly
    ? " AND publication_state = 'published'"
    : "";
  const row = await env.DB.prepare(
    `SELECT ${selectColumns} FROM calendar_events WHERE ${field} = ?${published} LIMIT 1`,
  )
    .bind(key)
    .first<CalendarRow>();
  return row ? rowToEvent(row) : null;
}

export async function createCalendarEvent(
  env: CalendarBindings,
  input: CalendarEventInput,
  actorId: string,
): Promise<CalendarEvent> {
  const id = crypto.randomUUID();
  const historyId = crypto.randomUUID();
  const now = Date.now();
  const snapshot = JSON.stringify({
    ...input,
    id,
    revision: 0,
    publicationState: "draft",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    publishedAt: null,
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO calendar_events (
          id, revision, slug, publication_state, event_status, category, title,
          summary, description, starts_at, ends_at, timezone, location_name,
          address, audience, what_to_bring, cost, registration_url, milestone,
          created_at, updated_at, published_at
        ) VALUES (?, 0, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(
        id,
        input.slug,
        input.eventStatus,
        input.category,
        input.title,
        input.summary,
        input.description,
        input.startsAt,
        input.endsAt,
        input.timezone,
        input.locationName,
        input.address,
        input.audience,
        input.whatToBring,
        input.cost,
        input.registrationUrl,
        input.milestone,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO calendar_event_history
          (id, event_id, revision, action, snapshot, actor_id, created_at)
         VALUES (?, ?, 0, 'created', ?, ?, ?)`,
      ).bind(historyId, id, snapshot, actorId, now),
    ]);
  } catch (error) {
    if (isUniqueError(error)) {
      throw new CalendarConflictError("Another event already uses that slug.");
    }
    throw error;
  }
  const event = await getCalendarEvent(env, id, false);
  if (!event) throw new Error("Created calendar event could not be read.");
  return event;
}

export async function updateCalendarEvent(
  env: CalendarBindings,
  id: string,
  input: CalendarEventInput,
  expectedRevision: number,
  actorId: string,
): Promise<CalendarEvent> {
  return mutateCalendarEvent(
    env,
    id,
    expectedRevision,
    actorId,
    "updated",
    input,
  );
}

export async function transitionCalendarEvent(
  env: CalendarBindings,
  id: string,
  state: Exclude<CalendarPublicationState, "draft">,
  expectedRevision: number,
  actorId: string,
): Promise<CalendarEvent> {
  return mutateCalendarEvent(
    env,
    id,
    expectedRevision,
    actorId,
    state === "published" ? "published" : "archived",
    undefined,
    state,
  );
}

async function mutateCalendarEvent(
  env: CalendarBindings,
  id: string,
  expectedRevision: number,
  actorId: string,
  action: "updated" | "published" | "archived",
  input?: CalendarEventInput,
  state?: Exclude<CalendarPublicationState, "draft">,
): Promise<CalendarEvent> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("Invalid expectedRevision");
  }
  const existing = await getCalendarEvent(env, id, false);
  if (!existing) throw new CalendarNotFoundError("Calendar event not found.");
  if (existing.revision !== expectedRevision) {
    throw new CalendarConflictError("The event changed since it was loaded.");
  }

  const now = Date.now();
  const revision = expectedRevision + 1;
  const nextState = state ?? existing.publicationState;
  const nextInput =
    input ??
    validateCalendarInput({
      ...existing,
    });
  const publishedAt =
    state === "published" ? now : existing.publishedAt
      ? Date.parse(existing.publishedAt)
      : null;
  const snapshot = JSON.stringify({
    ...nextInput,
    id,
    revision,
    publicationState: nextState,
    createdAt: existing.createdAt,
    updatedAt: new Date(now).toISOString(),
    publishedAt:
      publishedAt === null ? null : new Date(publishedAt).toISOString(),
  });

  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE calendar_events SET
          revision = ?, slug = ?, publication_state = ?, event_status = ?,
          category = ?, title = ?, summary = ?, description = ?, starts_at = ?,
          ends_at = ?, timezone = ?, location_name = ?, address = ?, audience = ?,
          what_to_bring = ?, cost = ?, registration_url = ?, milestone = ?,
          updated_at = ?, published_at = ?
         WHERE id = ? AND revision = ?`,
      ).bind(
        revision,
        nextInput.slug,
        nextState,
        nextInput.eventStatus,
        nextInput.category,
        nextInput.title,
        nextInput.summary,
        nextInput.description,
        nextInput.startsAt,
        nextInput.endsAt,
        nextInput.timezone,
        nextInput.locationName,
        nextInput.address,
        nextInput.audience,
        nextInput.whatToBring,
        nextInput.cost,
        nextInput.registrationUrl,
        nextInput.milestone,
        now,
        publishedAt,
        id,
        expectedRevision,
      ),
      env.DB.prepare(
        `INSERT INTO calendar_event_history
          (id, event_id, revision, action, snapshot, actor_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM calendar_events WHERE id = ? AND revision = ?
         )`,
      ).bind(
        crypto.randomUUID(),
        id,
        revision,
        action,
        snapshot,
        actorId,
        now,
        id,
        revision,
      ),
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      throw new CalendarConflictError("The event changed since it was loaded.");
    }
  } catch (error) {
    if (error instanceof CalendarConflictError) throw error;
    if (isRevisionConflictError(error)) {
      throw new CalendarConflictError("The event changed since it was loaded.");
    }
    if (isUniqueError(error)) {
      throw new CalendarConflictError("Another event already uses that slug.");
    }
    throw error;
  }

  const event = await getCalendarEvent(env, id, false);
  if (!event) throw new Error("Updated calendar event could not be read.");
  return event;
}

function isUniqueError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique constraint failed:\s*calendar_events\.slug/i.test(error.message)
  );
}

function isRevisionConflictError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique constraint failed:\s*calendar_event_history\.event_id\s*,\s*calendar_event_history\.revision/i.test(
      error.message,
    )
  );
}

export function renderCalendarIcs(events: CalendarEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cub Scout Pack 170//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Cub Scout Pack 170",
    `X-WR-TIMEZONE:${CALENDAR_TIMEZONE}`,
  ];

  for (const event of events) {
    const location = [event.locationName, event.address]
      .filter(Boolean)
      .join(", ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(event.id)}@macon170.com`,
      `SEQUENCE:${event.revision}`,
      `DTSTAMP:${toIcsDate(event.updatedAt)}`,
      `DTSTART:${toIcsDate(event.startsAt)}`,
    );
    if (event.endsAt) lines.push(`DTEND:${toIcsDate(event.endsAt)}`);
    lines.push(
      `SUMMARY:${escapeIcs(event.title)}`,
      `DESCRIPTION:${escapeIcs(event.description)}`,
      `STATUS:${
        event.eventStatus === "cancelled"
          ? "CANCELLED"
          : event.eventStatus === "tentative"
            ? "TENTATIVE"
            : "CONFIRMED"
      }`,
      `URL:https://www.macon170.com/events/?event=${encodeURIComponent(event.slug)}`,
    );
    if (location) lines.push(`LOCATION:${escapeIcs(location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.flatMap(foldIcsLine).join("\r\n")}\r\n`;
}

function escapeIcs(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function toIcsDate(value: string): string {
  return new Date(value)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function foldIcsLine(line: string): string[] {
  const encoder = new TextEncoder();
  const result: string[] = [];
  let segment = "";
  let maxBytes = 75;
  for (const character of line) {
    if (
      segment &&
      encoder.encode(segment + character).byteLength > maxBytes
    ) {
      result.push(result.length === 0 ? segment : ` ${segment}`);
      segment = character;
      maxBytes = 74;
    } else {
      segment += character;
    }
  }
  result.push(result.length === 0 ? segment : ` ${segment}`);
  return result;
}

export async function strongEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}
