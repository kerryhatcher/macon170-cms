/** Compare a legacy snapshot with the CMS v1 projection without mutating either system. */
type Row = Record<string, unknown> & {
  id?: string;
  legacy_event_id?: string;
  slug: string;
  visibility?: string;
};
const [legacyPath, projectionPath] = Bun.argv.slice(2);
if (!legacyPath || !projectionPath)
  throw new Error(
    "Usage: calendar-comparison-report.ts LEGACY_SNAPSHOT CMS_PROJECTION",
  );
const legacy = (await Bun.file(legacyPath).json()) as {
  events?: Row[];
  audit?: Array<{ event_id: string }>;
};
const cms = (await Bun.file(projectionPath).json()) as {
  version?: string;
  events?: Row[];
};
if (
  !Array.isArray(legacy.events) ||
  !Array.isArray(legacy.audit) ||
  cms.version !== "v1" ||
  !Array.isArray(cms.events)
)
  throw new Error("Invalid snapshot or v1 projection.");
const sequence = new Map<string, number>();
for (const audit of legacy.audit)
  sequence.set(audit.event_id, (sequence.get(audit.event_id) ?? 0) + 1);
const cmsBySlug = new Map(cms.events.map((event) => [event.slug, event]));
const differences = legacy.events
  .map((event) => {
    const projected = cmsBySlug.get(event.slug);
    if (event.visibility !== "published")
      return projected
        ? { slug: event.slug, issue: "non-published event leaked" }
        : null;
    if (!projected)
      return { slug: event.slug, issue: "missing published event" };
    const expected = {
      legacy_event_id: event.id,
      adapter_revision: sequence.get(event.id ?? "") ?? 0,
      slug: event.slug,
      status: event.status,
      category: event.category,
      title: event.title,
      summary: event.summary,
      description: event.description,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      timezone: event.timezone,
      location_name: event.location_name,
      address: event.address,
      audience: event.audience,
      what_to_bring: event.what_to_bring,
      cost: event.cost,
      registration_url: event.registration_url,
      milestone: event.milestone,
    };
    const mismatched = Object.keys(expected).filter(
      (key) =>
        JSON.stringify(expected[key as keyof typeof expected] ?? null) !==
        JSON.stringify(projected[key] ?? null),
    );
    return mismatched.length
      ? { slug: event.slug, issue: "field mismatch", fields: mismatched }
      : null;
  })
  .filter(Boolean);
console.log(
  JSON.stringify(
    {
      legacy_events: legacy.events.length,
      legacy_published: legacy.events.filter(
        (event) => event.visibility === "published",
      ).length,
      cms_published: cms.events.length,
      differences,
    },
    null,
    2,
  ),
);
