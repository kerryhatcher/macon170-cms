import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import {
  createCalendarEvent,
  updateCalendarEvent,
  renderCalendarIcs,
  validateCalendarInput,
  type CalendarBindings,
} from "./calendar";

const input = {
  title: "Fall Campout",
  slug: "fall-campout",
  summary: "A family overnight campout.",
  description: "Bring your camping equipment.",
  category: "family",
  eventStatus: "scheduled",
  startsAt: "2026-10-24T16:00:00Z",
  endsAt: "2026-10-25T16:00:00Z",
  timezone: "America/New_York",
  audience: "All families",
  allDay: true,
};

it("stores and updates all-day events with immutable history against the migrated schema", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(
      "CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE permissions (id TEXT PRIMARY KEY, name TEXT, description TEXT, category TEXT, created_at INTEGER); CREATE TABLE role_permissions (id TEXT PRIMARY KEY, role TEXT, permission_id TEXT, created_at INTEGER); INSERT INTO users VALUES ('admin-1');",
    );
    sqlite.exec(readFileSync("migrations/custom/0001_calendar.sql", "utf8"));
    sqlite.exec(
      readFileSync("migrations/custom/0006_calendar_all_day.sql", "utf8"),
    );
    const DB = {
      prepare(sql: string) {
        const stmt = sqlite.prepare(sql);
        let values: SQLInputValue[] = [];
        return {
          bind(...params: SQLInputValue[]) {
            values = params;
            return this;
          },
          async first() {
            return stmt.get(...values) ?? null;
          },
          async run() {
            return { meta: stmt.run(...values) };
          },
        };
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements)
            results.push(await statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const env = { DB } as unknown as CalendarBindings;
    const created = await createCalendarEvent(
      env,
      validateCalendarInput(input),
      "admin-1",
    );
    expect(created.allDay).toBe(true);
    expect(created.startsAt).toBe("2026-10-24T04:00:00.000Z");
    expect(created.endsAt).toBe("2026-10-26T03:59:59.999Z");
    expect(renderCalendarIcs([created])).toContain(
      "DTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261026",
    );
    const updated = await updateCalendarEvent(
      env,
      created.id,
      validateCalendarInput({ ...input, allDay: false }),
      0,
      "admin-1",
    );
    expect(updated.allDay).toBe(false);
    expect(updated.startsAt).toBe("2026-10-24T16:00:00.000Z");
    const snapshots = sqlite
      .prepare("SELECT snapshot FROM calendar_event_history ORDER BY revision")
      .all();
    expect(
      snapshots.map((row) => JSON.parse(String(row.snapshot)).allDay),
    ).toEqual([true, false]);
  } finally {
    sqlite.close();
  }
});

it("handles same-day dates, DST changes, old clients, and invalid flags", () => {
  expect(
    validateCalendarInput({
      ...input,
      startsAt: "2026-11-01T17:00:00Z",
      endsAt: null,
    }),
  ).toMatchObject({
    startsAt: "2026-11-01T04:00:00.000Z",
    endsAt: "2026-11-02T04:59:59.999Z",
    allDay: true,
  });
  expect(
    validateCalendarInput({
      ...input,
      startsAt: "2027-03-14T16:00:00Z",
      endsAt: null,
    }),
  ).toMatchObject({
    startsAt: "2027-03-14T05:00:00.000Z",
    endsAt: "2027-03-15T03:59:59.999Z",
  });
  expect(validateCalendarInput({ ...input, allDay: undefined }).allDay).toBe(
    false,
  );
  expect(() => validateCalendarInput({ ...input, allDay: "true" })).toThrow(
    "allDay",
  );
  expect(() =>
    validateCalendarInput({ ...input, endsAt: "2026-10-23T16:00:00Z" }),
  ).toThrow("End date");
});
