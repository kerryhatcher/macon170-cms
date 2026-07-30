import { describe, expect, it, vi } from "vitest";

import { smokeCalendar } from "./calendar-smoke";

const baseUrl = "https://cms.macon170.com";
const publicOrigin = "https://www.macon170.com";
const jsonEtag = '"events"';
const icsEtag = '"calendar"';

function successfulFetch(): typeof fetch {
  return vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/calendar/v1/events") {
      const headers = new Headers(init?.headers);
      if (headers.get("If-None-Match") === jsonEtag) {
        return new Response(null, { status: 304, headers: { ETag: jsonEtag } });
      }
      return Response.json(
        { version: "v1", events: [] },
        {
          headers: {
            "Access-Control-Allow-Origin": publicOrigin,
            ETag: jsonEtag,
          },
        },
      );
    }
    if (url.pathname === "/api/calendar/v1/calendar.ics") {
      const headers = {
        "Content-Type": "text/calendar; charset=UTF-8",
        ETag: icsEtag,
      };
      return init?.method === "HEAD"
        ? new Response(null, { headers })
        : new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { headers });
    }
    if (url.pathname === "/admin/calendar") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${baseUrl}/auth/login?returnTo=%2Fadmin%2Fcalendar`,
        },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe("calendar deployment smoke test", () => {
  it("checks JSON, CORS, ETags, ICS GET/HEAD, and login redirect", async () => {
    await expect(
      smokeCalendar({
        baseUrl,
        publicOrigin,
        fetchImpl: successfulFetch(),
      }),
    ).resolves.toEqual({ calendarVersion: "v1", eventCount: 0 });
  });

  it("fails when the calendar schema is unavailable", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "calendar_unavailable",
            message: "Calendar service unavailable.",
          },
        },
        { status: 500 },
      ),
    ) as typeof fetch;

    await expect(
      smokeCalendar({ baseUrl, publicOrigin, fetchImpl }),
    ).rejects.toThrow("calendar JSON returned 500");
  });
});
