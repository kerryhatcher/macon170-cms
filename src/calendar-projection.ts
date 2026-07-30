import type { Bindings } from "@sonicjs-cms/core";

type CalendarData = Record<string, unknown>;

export type CalendarProjectionEvent = {
  legacy_event_id: string;
  adapter_revision: number;
  slug: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  status: "scheduled" | "tentative" | "cancelled";
  category: "pack" | "den" | "family";
  title: string;
  summary: string;
  description: string;
  starts_at: string;
  ends_at: string | null;
  timezone: "America/New_York";
  location_name: string | null;
  address: string | null;
  audience: string;
  what_to_bring: string | null;
  cost: string | null;
  registration_url: string | null;
  milestone: string | null;
};

type ContentRow = {
  slug: string;
  data: string;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

const categories = new Set(["pack", "den", "family"]);
const statuses = new Set(["scheduled", "tentative", "cancelled"]);
const milestones = new Set([
  "lego-derby",
  "fall-camp",
  "pinewood-derby",
  "blue-gold",
]);

export async function publishedCalendarProjection(
  env: Bindings,
): Promise<CalendarProjectionEvent[]> {
  const rows = await env.DB.prepare(
    `
    SELECT content.slug, content.data, content.created_at, content.updated_at, content.published_at
    FROM content JOIN collections ON collections.id = content.collection_id
    WHERE collections.name = 'calendar-event' AND content.status = 'published'
    ORDER BY json_extract(content.data, '$.startsAt') DESC LIMIT 500
  `,
  ).all<ContentRow>();
  return rows.results.map((row) => toProjection(row));
}

export function toProjection(row: ContentRow): CalendarProjectionEvent {
  const data = JSON.parse(row.data) as CalendarData;
  const event = validateCalendarData({ ...data, slug: row.slug });
  return {
    legacy_event_id: event.legacyEventId,
    adapter_revision: event.adapterRevision,
    slug: event.slug,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    published_at:
      row.published_at === null
        ? null
        : new Date(row.published_at).toISOString(),
    status: event.eventStatus,
    category: event.category,
    title: event.title,
    summary: event.summary,
    description: event.description,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    timezone: "America/New_York",
    location_name: event.locationName,
    address: event.address,
    audience: event.audience,
    what_to_bring: event.whatToBring,
    cost: event.cost,
    registration_url: event.registrationUrl,
    milestone: event.milestone,
  };
}

export function validateCalendarData(input: CalendarData): Required<
  Pick<
    CalendarProjectionEvent,
    "slug" | "title" | "summary" | "description" | "category" | "audience"
  >
> & {
  eventStatus: CalendarProjectionEvent["status"];
  startsAt: string;
  endsAt: string | null;
  legacyEventId: string;
  adapterRevision: number;
  locationName: string | null;
  address: string | null;
  whatToBring: string | null;
  cost: string | null;
  registrationUrl: string | null;
  milestone: string | null;
} {
  const text = (key: string, min: number, max: number) => {
    const value = input[key];
    if (
      typeof value !== "string" ||
      value.trim().length < min ||
      value.trim().length > max
    )
      throw new Error(`Invalid ${key}`);
    return value.trim();
  };
  const optional = (key: string, max: number) => {
    const value = input[key];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || value.trim().length > max)
      throw new Error(`Invalid ${key}`);
    return value.trim() || null;
  };
  const slug = text("slug", 2, 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Invalid slug");
  const startsAt = iso(input.startsAt, "startsAt");
  const endsAt =
    input.endsAt === null || input.endsAt === undefined || input.endsAt === ""
      ? null
      : iso(input.endsAt, "endsAt");
  if (endsAt && endsAt < startsAt)
    throw new Error("End date must be after the start date");
  if (input.timezone !== "America/New_York")
    throw new Error("Pack 170 events use America/New_York");
  const category = text(
    "category",
    1,
    20,
  ) as CalendarProjectionEvent["category"];
  const eventStatus = text(
    "eventStatus",
    1,
    20,
  ) as CalendarProjectionEvent["status"];
  if (!categories.has(category) || !statuses.has(eventStatus))
    throw new Error("Invalid event category or status");
  const registrationUrl = optional("registrationUrl", 2000);
  if (registrationUrl && !/^https?:\/\//.test(registrationUrl))
    throw new Error("Registration link must use HTTP or HTTPS");
  const milestone = optional("milestone", 80);
  if (milestone && !milestones.has(milestone))
    throw new Error("Invalid milestone");
  const adapterRevision = input.adapterRevision;
  if (!Number.isInteger(adapterRevision) || (adapterRevision as number) < 0)
    throw new Error("Invalid adapterRevision");
  return {
    slug,
    title: text("title", 3, 160),
    summary: text("summary", 10, 500),
    description: text("description", 10, 8000),
    category,
    eventStatus,
    startsAt,
    endsAt,
    audience: text("audience", 2, 300),
    legacyEventId: text("legacyEventId", 36, 36),
    adapterRevision: adapterRevision as number,
    locationName: optional("locationName", 200),
    address: optional("address", 300),
    whatToBring: optional("whatToBring", 2000),
    cost: optional("cost", 500),
    registrationUrl,
    milestone,
  };
}

function iso(value: unknown, key: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new Error(`Invalid ${key}`);
  return new Date(value).toISOString();
}
