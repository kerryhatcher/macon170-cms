import { describe, expect, it, vi } from "vitest";

import { runSignupRetention } from "./signup-store";
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
});
