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
  paymentUrl: null,
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

  it("accepts an https payment URL and trims it", () => {
    expect(
      validateCalendarInput({
        ...input,
        paymentUrl: "  https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00  ",
      }).paymentUrl,
    ).toBe("https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00");
  });

  it("treats a missing, empty, or null payment URL as null", () => {
    const { paymentUrl: _omitted, ...withoutPayment } = input;
    expect(validateCalendarInput(withoutPayment).paymentUrl).toBeNull();
    expect(
      validateCalendarInput({ ...input, paymentUrl: "" }).paymentUrl,
    ).toBeNull();
    expect(
      validateCalendarInput({ ...input, paymentUrl: null }).paymentUrl,
    ).toBeNull();
  });

  it("rejects payment URLs that are not https, not URLs, or too long", () => {
    for (const paymentUrl of [
      "http://buy.stripe.com/x",
      "javascript:alert(1)",
      "ftp://example.com/x",
    ]) {
      expect(() =>
        validateCalendarInput({ ...input, paymentUrl }),
      ).toThrow("Payment URL must use HTTPS");
    }
    expect(() =>
      validateCalendarInput({ ...input, paymentUrl: "buy.stripe.com/x" }),
    ).toThrow("Invalid paymentUrl");
    expect(() =>
      validateCalendarInput({
        ...input,
        paymentUrl: `https://example.com/${"a".repeat(2000)}`,
      }),
    ).toThrow("Invalid paymentUrl");
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
      payment_url: null,
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

  const stripeLink = "https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00";

  function rowFor(source: typeof event) {
    return {
      id: source.id,
      revision: source.revision,
      slug: source.slug,
      publication_state: source.publicationState,
      event_status: source.eventStatus,
      category: source.category,
      title: source.title,
      summary: source.summary,
      description: source.description,
      starts_at: source.startsAt,
      ends_at: source.endsAt,
      all_day: source.allDay ? 1 : 0,
      timezone: source.timezone,
      location_name: source.locationName,
      address: source.address,
      audience: source.audience,
      what_to_bring: source.whatToBring,
      cost: source.cost,
      registration_url: source.registrationUrl,
      payment_url: source.paymentUrl,
      milestone: source.milestone,
      created_at: Date.parse(source.createdAt),
      updated_at: Date.parse(source.updatedAt),
      published_at: Date.parse(source.publishedAt),
    };
  }

  function capturingDb(row: ReturnType<typeof rowFor>) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          statements.push(this);
          return this;
        },
        first: async () => row,
      }),
      batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, {}]),
    };
    return { db, statements };
  }

  it("writes payment_url on create with one bind per placeholder", async () => {
    const { db, statements } = capturingDb(
      rowFor({ ...event, paymentUrl: stripeLink }),
    );
    const created = await createCalendarEvent(
      { DB: db } as unknown as Bindings,
      validateCalendarInput({ ...input, paymentUrl: stripeLink }),
      "admin-1",
    );
    const insert = statements.find((s) =>
      s.sql.includes("INSERT INTO calendar_events"),
    )!;
    expect(insert.sql).toContain("payment_url");
    expect(insert.values).toContain(stripeLink);
    expect(insert.sql.match(/\?/g)).toHaveLength(insert.values.length);
    const history = statements.find((s) =>
      s.sql.includes("INSERT INTO calendar_event_history"),
    )!;
    expect(JSON.parse(String(history.values[2])).paymentUrl).toBe(stripeLink);
    expect(created.paymentUrl).toBe(stripeLink);
  });

  it("writes payment_url on update with one bind per placeholder", async () => {
    const { db, statements } = capturingDb(rowFor(event));
    await updateCalendarEvent(
      { DB: db } as unknown as Bindings,
      event.id,
      validateCalendarInput({ ...input, paymentUrl: stripeLink }),
      event.revision,
      "admin-1",
    );
    const update = statements.find((s) =>
      s.sql.includes("UPDATE calendar_events SET"),
    )!;
    expect(update.sql).toContain("payment_url = ?");
    expect(update.values).toContain(stripeLink);
    expect(update.sql.match(/\?/g)).toHaveLength(update.values.length);
    const history = statements.find((s) =>
      s.sql.includes("INSERT INTO calendar_event_history"),
    )!;
    expect(JSON.parse(String(history.values[4])).paymentUrl).toBe(stripeLink);
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
      payment_url: event.paymentUrl,
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
      payment_url: event.paymentUrl,
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
