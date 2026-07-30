import type { Bindings } from "@sonicjs-cms/core";
import { describe, expect, it, vi } from "vitest";

import {
  CalendarConflictError,
  createCalendarEvent,
  foldIcsLine,
  renderCalendarIcs,
  strongEtag,
  updateCalendarEvent,
  validateCalendarInput,
} from "./calendar";

const input = {
  title: "Pack Meeting",
  slug: "pack-meeting",
  summary: "A monthly gathering for Pack 170 families.",
  description: "Families gather for activities and announcements.",
  category: "pack",
  eventStatus: "scheduled",
  startsAt: "2027-01-12T23:30:00-05:00",
  endsAt: "2027-01-13T00:30:00-05:00",
  timezone: "America/New_York",
  audience: "All Pack 170 families",
  locationName: null,
  address: null,
  whatToBring: null,
  cost: null,
  registrationUrl: null,
  milestone: null,
};

const event = {
  ...validateCalendarInput(input),
  id: "11111111-1111-4111-8111-111111111111",
  revision: 4,
  publicationState: "published" as const,
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-01-02T00:00:00.000Z",
  publishedAt: "2027-01-02T00:00:00.000Z",
};

describe("calendar validation", () => {
  it("normalizes timezone-aware instants and nullable fields", () => {
    expect(validateCalendarInput(input)).toEqual(
      expect.objectContaining({
        startsAt: "2027-01-13T04:30:00.000Z",
        endsAt: "2027-01-13T05:30:00.000Z",
        timezone: "America/New_York",
      }),
    );
  });

  it("rejects invalid order, timezone, URL scheme, enum, and milestone", () => {
    expect(() =>
      validateCalendarInput({
        ...input,
        endsAt: "2027-01-12T22:00:00-05:00",
      }),
    ).toThrow("End date");
    expect(() => validateCalendarInput({ ...input, timezone: "UTC" })).toThrow(
      "America/New_York",
    );
    expect(() =>
      validateCalendarInput({ ...input, registrationUrl: "javascript:x" }),
    ).toThrow("HTTP or HTTPS");
    expect(() =>
      validateCalendarInput({ ...input, category: "district" }),
    ).toThrow("category");
    expect(() =>
      validateCalendarInput({ ...input, milestone: "summer-camp" }),
    ).toThrow("milestone");
  });

  it("requires instants to include an explicit timezone", () => {
    expect(() =>
      validateCalendarInput({ ...input, startsAt: "2027-01-12T18:30:00" }),
    ).toThrow("startsAt");
  });
});

describe("calendar ICS", () => {
  it("preserves UID, sequence, UTC dates, statuses, URLs, and CRLF", () => {
    const ics = renderCalendarIcs([
      {
        ...event,
        title: "Pack, Meeting; Night",
        description: "Bring water\nHave fun",
        eventStatus: "cancelled",
      },
    ]);
    expect(ics).toContain(
      "UID:11111111-1111-4111-8111-111111111111@macon170.com\r\n",
    );
    expect(ics).toContain("SEQUENCE:4\r\n");
    expect(ics).toContain("DTSTART:20270113T043000Z\r\n");
    expect(ics).toContain("STATUS:CANCELLED\r\n");
    expect(ics).toContain(
      "URL:https://www.macon170.com/events/?event=pack-meeting\r\n",
    );
    expect(ics).toContain("SUMMARY:Pack\\, Meeting\\; Night\r\n");
    expect(ics).toContain("DESCRIPTION:Bring water\\nHave fun\r\n");
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("folds multibyte content to RFC 5545 octet limits", () => {
    const lines = foldIcsLine(`DESCRIPTION:${"🐺".repeat(50)}`);
    const encoder = new TextEncoder();
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => encoder.encode(line).byteLength <= 75)).toBe(
      true,
    );
    expect(lines.slice(1).every((line) => line.startsWith(" "))).toBe(true);
  });

  it("creates deterministic strong ETags", async () => {
    await expect(strongEtag("same")).resolves.toBe(await strongEtag("same"));
    await expect(strongEtag("same")).resolves.not.toBe(
      await strongEtag("different"),
    );
  });
});

describe("calendar persistence", () => {
  it("creates an event and its initial history in one batch", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const row = {
      id: "generated",
      revision: 0,
      slug: input.slug,
      publication_state: "draft",
      event_status: input.eventStatus,
      category: input.category,
      title: input.title,
      summary: input.summary,
      description: input.description,
      starts_at: "2027-01-13T04:30:00.000Z",
      ends_at: "2027-01-13T05:30:00.000Z",
      timezone: input.timezone,
      location_name: null,
      address: null,
      audience: input.audience,
      what_to_bring: null,
      cost: null,
      registration_url: null,
      milestone: null,
      created_at: 1,
      updated_at: 1,
      published_at: null,
    };
    const db = {
      prepare: (sql: string) => {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            statements.push(this);
            return this;
          },
          first: async () => ({ ...row, id: statements[0]?.values[0] }),
        };
        return statement;
      },
      batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, {}]),
    };
    const created = await createCalendarEvent(
      { DB: db } as unknown as Bindings,
      validateCalendarInput(input),
      "admin-1",
    );
    expect(db.batch).toHaveBeenCalledOnce();
    expect(statements.some((statement) => statement.sql.includes("history"))).toBe(
      true,
    );
    expect(created.publicationState).toBe("draft");
    expect(created.revision).toBe(0);
  });

  it("reports optimistic conflicts without overwriting", async () => {
    const row = {
      id: event.id,
      revision: event.revision,
      slug: event.slug,
      publication_state: event.publicationState,
      event_status: event.eventStatus,
      category: event.category,
      title: event.title,
      summary: event.summary,
      description: event.description,
      starts_at: event.startsAt,
      ends_at: event.endsAt,
      timezone: event.timezone,
      location_name: event.locationName,
      address: event.address,
      audience: event.audience,
      what_to_bring: event.whatToBring,
      cost: event.cost,
      registration_url: event.registrationUrl,
      milestone: event.milestone,
      created_at: Date.parse(event.createdAt),
      updated_at: Date.parse(event.updatedAt),
      published_at: Date.parse(event.publishedAt),
    };
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => row,
      }),
      batch: vi.fn(),
    };
    await expect(
      updateCalendarEvent(
        { DB: db } as unknown as Bindings,
        event.id,
        validateCalendarInput(input),
        event.revision - 1,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(CalendarConflictError);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("reports concurrent history collisions as revision conflicts, not slug conflicts", async () => {
    const row = {
      id: event.id,
      revision: event.revision,
      slug: event.slug,
      publication_state: event.publicationState,
      event_status: event.eventStatus,
      category: event.category,
      title: event.title,
      summary: event.summary,
      description: event.description,
      starts_at: event.startsAt,
      ends_at: event.endsAt,
      timezone: event.timezone,
      location_name: event.locationName,
      address: event.address,
      audience: event.audience,
      what_to_bring: event.whatToBring,
      cost: event.cost,
      registration_url: event.registrationUrl,
      milestone: event.milestone,
      created_at: Date.parse(event.createdAt),
      updated_at: Date.parse(event.updatedAt),
      published_at: Date.parse(event.publishedAt),
    };
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => row,
      }),
      batch: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "UNIQUE constraint failed: calendar_event_history.event_id, calendar_event_history.revision",
          ),
        ),
    };
    await expect(
      updateCalendarEvent(
        { DB: db } as unknown as Bindings,
        event.id,
        validateCalendarInput(input),
        event.revision,
        "admin-1",
      ),
    ).rejects.toMatchObject({
      name: "Error",
      message: "The event changed since it was loaded.",
    });
  });
});
