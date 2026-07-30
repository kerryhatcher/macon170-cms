import type { Bindings } from "@sonicjs-cms/core";
import { describe, expect, it } from "vitest";

import {
  publishedCalendarProjection,
  validateCalendarData,
} from "./calendar-projection";

const data = {
  title: "Pack Meeting",
  slug: "pack-meeting",
  summary: "A monthly gathering for Pack 170 families.",
  description: "Families gather for activities and announcements.",
  category: "pack",
  eventStatus: "scheduled",
  startsAt: "2027-01-12T23:30:00.000Z",
  endsAt: "2027-01-13T00:30:00.000Z",
  timezone: "America/New_York",
  audience: "All Pack 170 families",
  legacyEventId: "11111111-1111-4111-8111-111111111111",
  adapterRevision: 2,
};

describe("calendar projection", () => {
  it("maps published SonicJS records to the v1 DTO", async () => {
    const env = {
      DB: {
        prepare: () => ({
          all: async () => ({
            results: [
              {
                slug: data.slug,
                data: JSON.stringify(data),
                created_at: 1_800_000_000_000,
                updated_at: 1_800_000_100_000,
                published_at: 1_800_000_050_000,
              },
            ],
          }),
        }),
      },
    } as unknown as Bindings;
    await expect(publishedCalendarProjection(env)).resolves.toEqual([
      expect.objectContaining({
        legacy_event_id: data.legacyEventId,
        adapter_revision: 2,
        status: "scheduled",
      }),
    ]);
  });

  it("rejects bad event timing, timezone, and milestones", () => {
    expect(() =>
      validateCalendarData({ ...data, endsAt: "2027-01-12T22:00:00.000Z" }),
    ).toThrow("End date");
    expect(() => validateCalendarData({ ...data, timezone: "UTC" })).toThrow(
      "America/New_York",
    );
    expect(() =>
      validateCalendarData({ ...data, milestone: "summer-camp" }),
    ).toThrow("Invalid milestone");
  });
});
