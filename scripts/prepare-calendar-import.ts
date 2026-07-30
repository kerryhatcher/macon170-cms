/**
 * Prepare an idempotent SonicJS content import from a read-only legacy D1
 * snapshot. This never contacts Cloudflare or writes a database.
 *
 * Usage: bun scripts/prepare-calendar-import.ts legacy-snapshot.json COLLECTION_ID ADMIN_USER_ID > calendar-import.sql
 * The snapshot must contain `{ events: [...], audit: [...] }`, where audit rows
 * contain `event_id`. Run the generated SQL only in an approved maintenance
 * window against the CMS database.
 */
type LegacyEvent = Record<string, unknown> & {
  id: string;
  slug: string;
  title: string;
  visibility: string;
  created_at: string;
  updated_at: string;
};

const [snapshotPath, collectionId, authorId] = Bun.argv.slice(2);
if (!snapshotPath || !collectionId || !authorId)
  throw new Error(
    "Usage: prepare-calendar-import.ts SNAPSHOT COLLECTION_ID ADMIN_USER_ID",
  );
const snapshot = (await Bun.file(snapshotPath).json()) as {
  events?: LegacyEvent[];
  audit?: Array<{ event_id: string }>;
};
if (!Array.isArray(snapshot.events) || !Array.isArray(snapshot.audit))
  throw new Error("Snapshot must contain events and audit arrays.");
const sequences = new Map<string, number>();
for (const entry of snapshot.audit)
  sequences.set(entry.event_id, (sequences.get(entry.event_id) ?? 0) + 1);
const literal = (value: unknown) =>
  `'${String(value ?? "").replaceAll("'", "''")}'`;
const millis = (value: unknown) => new Date(String(value)).getTime();

console.log("BEGIN;");
for (const event of [...snapshot.events].sort((a, b) =>
  a.slug.localeCompare(b.slug),
)) {
  const data = {
    title: event.title,
    slug: event.slug,
    summary: event.summary,
    description: event.description,
    category: event.category,
    eventStatus: event.status,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    timezone: event.timezone,
    locationName: event.location_name,
    address: event.address,
    audience: event.audience,
    whatToBring: event.what_to_bring,
    cost: event.cost,
    registrationUrl: event.registration_url,
    milestone: event.milestone,
    legacyEventId: event.id,
    adapterRevision: sequences.get(event.id) ?? 0,
  };
  const status =
    event.visibility === "published"
      ? "published"
      : event.visibility === "archived"
        ? "archived"
        : "draft";
  const publishedAt = event.published_at ? millis(event.published_at) : "NULL";
  console.log(
    `INSERT INTO content (id, collection_id, slug, title, data, status, author_id, created_at, updated_at, published_at) VALUES (${literal(event.id)}, ${literal(collectionId)}, ${literal(event.slug)}, ${literal(event.title)}, ${literal(JSON.stringify(data))}, ${literal(status)}, ${literal(authorId)}, ${millis(event.created_at)}, ${millis(event.updated_at)}, ${publishedAt}) ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, title = excluded.title, data = excluded.data, status = excluded.status, updated_at = excluded.updated_at, published_at = excluded.published_at;`,
  );
}
console.log("COMMIT;");
