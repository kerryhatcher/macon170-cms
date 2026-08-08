import { describe, expect, it, vi } from "vitest";

import { runSignupRetention } from "./signup-store";
import { SIGNUP_RETENTION_DAYS } from "./signups";
import type { SignupBindings } from "./signups";

function collectingDb() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      sql,
      bind(...values: unknown[]) {
        statements.push({ sql, values });
        return this;
      },
    }),
    batch: vi
      .fn()
      .mockResolvedValue([
        { meta: { changes: 2 } },
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
      ]),
  };
  return { db, statements };
}

describe("signup retention", () => {
  it("purges unconfirmed responses past the 24 hour window", async () => {
    const { db, statements } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    const purge = statements.find(
      (entry) =>
        entry.sql.includes("DELETE FROM signup_responses") &&
        entry.sql.includes("'unconfirmed'"),
    );
    expect(purge).toBeDefined();
    const cutoff = purge?.values[0] as number;
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000);
    expect(Date.now() - cutoff).toBeLessThan(25 * 60 * 60 * 1_000);
  });

  it("deletes aged responses but never their forms or slots", async () => {
    const { db, statements } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    const sql = statements.map((entry) => entry.sql).join("\n");
    expect(sql).toContain("DELETE FROM signup_responses");
    expect(sql).not.toContain("DELETE FROM signup_forms");
    expect(sql).not.toContain("DELETE FROM signup_slots");
  });

  it("purges audit rows older than a year", async () => {
    const { db, statements } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    const audit = statements.find((entry) =>
      entry.sql.includes("DELETE FROM signup_audit"),
    );
    expect(audit).toBeDefined();
    const cutoff = audit?.values[0] as number;
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(
      365 * 24 * 60 * 60 * 1_000,
    );
  });

  it("runs every pass in a single batch", async () => {
    const { db } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it("binds the 90-day cutoff as an ISO date string, not a millisecond number", async () => {
    // calendar_events.starts_at/ends_at are TEXT columns holding ISO instants.
    // Binding a number here would compare a number to text and silently
    // match zero rows — the exact failure mode this test guards against.
    // Matched by SQL content (references calendar_events), not array index,
    // so this stays correct if statement order changes.
    const { db, statements } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    const aged = statements.find((entry) =>
      entry.sql.includes("calendar_events"),
    );
    expect(aged).toBeDefined();
    const cutoff = aged?.values[0];
    expect(typeof cutoff).toBe("string");
    expect(cutoff as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const cutoffMs = Date.parse(cutoff as string);
    const expectedAgeMs = SIGNUP_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
    const toleranceMs = 60 * 60 * 1_000;
    expect(Date.now() - cutoffMs).toBeGreaterThanOrEqual(
      expectedAgeMs - toleranceMs,
    );
    expect(Date.now() - cutoffMs).toBeLessThan(expectedAgeMs + toleranceMs);
  });

  it("logs each pass's deleted count under its own key, not swapped", async () => {
    const { db } = collectingDb();
    // Distinct values are the point: equal counts would let a swap between
    // results[0]/[1]/[2] pass unnoticed.
    db.batch.mockResolvedValue([
      { meta: { changes: 7 } },
      { meta: { changes: 5 } },
      { meta: { changes: 3 } },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSignupRetention({ DB: db } as unknown as SignupBindings);
      expect(logSpy).toHaveBeenCalledOnce();
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.unconfirmedDeleted).toBe(7);
      expect(logged.agedResponsesDeleted).toBe(5);
      expect(logged.auditDeleted).toBe(3);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs all-zero counts rather than skipping the line", async () => {
    const { db } = collectingDb();
    db.batch.mockResolvedValue([
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSignupRetention({ DB: db } as unknown as SignupBindings);
      expect(logSpy).toHaveBeenCalledOnce();
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.unconfirmedDeleted).toBe(0);
      expect(logged.agedResponsesDeleted).toBe(0);
      expect(logged.auditDeleted).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
