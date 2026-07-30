type CalendarSmokeOptions = {
  baseUrl: string;
  publicOrigin: string;
  fetchImpl?: typeof fetch;
};

export type CalendarSmokeResult = {
  calendarVersion: string;
  eventCount: number;
};

function check(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

export async function smokeCalendar({
  baseUrl,
  publicOrigin,
  fetchImpl = fetch,
}: CalendarSmokeOptions): Promise<CalendarSmokeResult> {
  const origin = baseUrl.replace(/\/$/, "");
  const readResponse = (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> =>
    fetchImpl(`${origin}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      ...init,
    });

  const events = await readResponse("/api/calendar/v1/events", {
    headers: { Origin: publicOrigin },
  });
  check(events.status === 200, `calendar JSON returned ${events.status}`);
  check(
    events.headers.get("access-control-allow-origin") === publicOrigin,
    "calendar JSON did not return the expected CORS origin",
  );
  check(
    events.headers.get("content-type")?.startsWith("application/json"),
    "calendar JSON returned the wrong content type",
  );
  const eventsEtag = events.headers.get("etag");
  check(eventsEtag, "calendar JSON did not return an ETag");
  const payload: unknown = await events.json();
  check(
    typeof payload === "object" && payload !== null,
    "calendar JSON returned an invalid object",
  );
  const calendarPayload = payload as {
    version?: unknown;
    events?: unknown;
  };
  check(
    calendarPayload.version === "v1",
    "calendar JSON returned the wrong version",
  );
  check(
    Array.isArray(calendarPayload.events),
    "calendar JSON did not return an events array",
  );

  const conditionalEvents = await readResponse("/api/calendar/v1/events", {
    headers: { "If-None-Match": eventsEtag, Origin: publicOrigin },
  });
  check(
    conditionalEvents.status === 304,
    `conditional calendar JSON returned ${conditionalEvents.status}`,
  );

  const calendar = await readResponse("/api/calendar/v1/calendar.ics");
  check(calendar.status === 200, `calendar ICS returned ${calendar.status}`);
  check(
    calendar.headers.get("content-type")?.startsWith("text/calendar"),
    "calendar ICS returned the wrong content type",
  );
  const calendarEtag = calendar.headers.get("etag");
  check(calendarEtag, "calendar ICS did not return an ETag");
  const calendarBody = await calendar.text();
  check(
    calendarBody.startsWith("BEGIN:VCALENDAR\r\n") &&
      calendarBody.endsWith("END:VCALENDAR\r\n"),
    "calendar ICS returned an invalid calendar envelope",
  );

  const calendarHead = await readResponse("/api/calendar/v1/calendar.ics", {
    method: "HEAD",
  });
  check(
    calendarHead.status === 200,
    `calendar ICS HEAD returned ${calendarHead.status}`,
  );
  check(
    calendarHead.headers.get("etag") === calendarEtag,
    "calendar ICS HEAD did not match the GET ETag",
  );
  check(
    (await calendarHead.text()) === "",
    "calendar ICS HEAD returned a body",
  );

  const admin = await readResponse("/admin/calendar");
  check(admin.status === 302, `calendar admin returned ${admin.status}`);
  check(
    admin.headers.get("location") ===
      `${origin}/auth/login?returnTo=%2Fadmin%2Fcalendar`,
    "calendar admin did not redirect to the expected login URL",
  );

  return {
    calendarVersion: calendarPayload.version,
    eventCount: calendarPayload.events.length,
  };
}
