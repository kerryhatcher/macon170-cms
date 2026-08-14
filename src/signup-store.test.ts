import { describe, expect, it, vi } from "vitest";

import { createSignupForm, getPublicSignupForm, updateSignupForm } from "./signup-store";
import { SignupConflictError, SignupRequestError, validateSignupFormInput } from "./signups";
import type { SignupBindings } from "./signups";

const formInput = validateSignupFormInput({
  slug: "lego-derby-food",
  eventId: "evt-1",
  formType: "items",
  title: "Lego Derby food",
  instructions: "",
  state: "open",
  closesAt: null,
  slots: [{ label: "Hot dog buns", quantityNeeded: 3, notes: null }],
});

const formRow = {
  id: "frm-1",
  revision: 2,
  slug: "lego-derby-food",
  event_id: "evt-1",
  form_type: "items",
  title: "Lego Derby food",
  instructions: "",
  state: "open",
  closes_at: null,
  created_at: 1,
  updated_at: 1,
};

// Decoy family columns the projection must never copy. They are deliberately
// present in the mock rows: an assertion that the response lacks family data
// proves nothing if the row it was built from never held any. A regression that
// spreads the raw row into the public shape has to fail this test.
const familyDecoys = {
  email: "decoy@example.com",
  family_name: "Decoy Family",
  phone: "478-555-0199",
  dietary_notes: "decoy peanut allergy",
  adults: 9,
  children: 9,
};

describe("public signup form projection", () => {
  it("exposes only counts and never family data", async () => {
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () =>
          sql.includes("FROM signup_forms")
            ? {
                ...formRow,
                ...familyDecoys,
                event_slug: "lego-derby",
                event_title: "Lego Derby",
                event_starts_at: "2027-03-01T18:00:00.000Z",
              }
            : null,
        all: async () => ({
          results: [
            {
              id: "slt-1",
              form_id: "frm-1",
              position: 0,
              label: "Hot dog buns",
              quantity_needed: 3,
              notes: null,
              created_at: 1,
              updated_at: 1,
              quantity_claimed: 2,
              ...familyDecoys,
            },
          ],
        }),
      }),
    };

    const form = await getPublicSignupForm(
      { DB: db } as unknown as SignupBindings,
      "lego-derby-food",
    );

    expect(form?.slots[0]).toEqual({
      id: "slt-1",
      label: "Hot dog buns",
      notes: null,
      quantityNeeded: 3,
      quantityClaimed: 2,
      quantityRemaining: 1,
    });
    const serialized = JSON.stringify(form);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("dietary");
    expect(serialized).not.toContain("familyName");
    expect(serialized).not.toContain("adults");
    // Catches a leak under either naming convention, camelCase or raw column.
    expect(serialized).not.toContain("Decoy");
    expect(serialized).not.toContain("decoy");
    expect(serialized).not.toContain("family_name");
    expect(serialized).not.toContain("478-555");
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("children");
  });

  it("reports a passed deadline as closed while staying readable", async () => {
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () => ({
          ...formRow,
          closes_at: "2000-01-01T00:00:00.000Z",
          event_slug: "lego-derby",
          event_title: "Lego Derby",
          event_starts_at: "2027-03-01T18:00:00.000Z",
        }),
        all: async () => ({ results: [] }),
      }),
    };
    const form = await getPublicSignupForm(
      { DB: db } as unknown as SignupBindings,
      "lego-derby-food",
    );
    expect(form?.closed).toBe(true);
  });

  it("returns null for a draft form", async () => {
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    };
    await expect(
      getPublicSignupForm(
        { DB: db } as unknown as SignupBindings,
        "hidden",
      ),
    ).resolves.toBeNull();
  });
});

describe("signup form updates", () => {
  it("rejects a stale revision without writing", async () => {
    const batch = vi.fn();
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () => formRow,
        all: async () => ({ results: [] }),
      }),
      batch,
    };
    await expect(
      updateSignupForm(
        { DB: db } as unknown as SignupBindings,
        "frm-1",
        formInput,
        formRow.revision - 1,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(SignupConflictError);
    expect(batch).not.toHaveBeenCalled();
  });

  it("bumps the revision and inserts new slots in one batch", async () => {
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    const updated = await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      formInput,
      formRow.revision,
      "admin-1",
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_slots")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(true);
    expect(updated.revision).toBe(3);
  });

  it("keeps the stored slot row when a save changes only form metadata", async () => {
    // A volunteer fixing a typo in the title submits the same slot, by id.
    // Reconciling by id must recognize it as unchanged and skip the UPDATE
    // as well as any DELETE/INSERT — a title-only save must never touch
    // signup_slots at all.
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlot = {
      id: "slt-1",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [storedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-1",
            position: 0,
            label: "Hot dog buns",
            quantityNeeded: 3,
            notes: null,
          },
        ],
        title: "Lego Derby food (fixed)",
      },
      formRow.revision,
      "admin-1",
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(
      statements.some((sql) => sql.includes("DELETE FROM signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("UPDATE signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(true);
  });

  it("replaces slots when the submitted item list differs", async () => {
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({
            results: [
              {
                id: "slt-1",
                form_id: "frm-1",
                position: 0,
                label: "Buns of a different name",
                quantity_needed: 3,
                notes: null,
                created_at: 1,
                updated_at: 1,
              },
            ],
          }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      formInput,
      formRow.revision,
      "admin-1",
    );
    expect(statements.some((sql) => sql.includes("DELETE FROM signup_slots"))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes("INSERT INTO signup_slots"))).toBe(
      true,
    );
  });

  it("inserts a new slot without touching an existing one's row", async () => {
    // The bug this fixes: adding "napkins" to an open items form used to
    // replace the entire slot list, cascading every family's claims via
    // ON DELETE CASCADE — not just claims on the new row. Reconciling by id
    // means the existing slot's row is neither deleted nor updated.
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlot = {
      id: "slt-1",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [storedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-1",
            position: 0,
            label: "Hot dog buns",
            quantityNeeded: 3,
            notes: null,
          },
          { position: 1, label: "Napkins", quantityNeeded: 2, notes: null },
        ],
      },
      formRow.revision,
      "admin-1",
    );
    expect(
      statements.some((sql) => sql.includes("DELETE FROM signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("UPDATE signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_slots")),
    ).toBe(true);
  });

  it("removes only the deleted slot, leaving another slot's row untouched", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const keptSlot = {
      id: "slt-keep",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const removedSlot = {
      id: "slt-remove",
      form_id: "frm-1",
      position: 1,
      label: "Drinks",
      quantity_needed: 2,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        const call = { sql, args: [] as unknown[] };
        statements.push(call);
        return {
          sql,
          bind(...args: unknown[]) {
            call.args = args;
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [keptSlot, removedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-keep",
            position: 0,
            label: "Hot dog buns",
            quantityNeeded: 3,
            notes: null,
          },
        ],
      },
      formRow.revision,
      "admin-1",
    );
    const deletes = statements.filter((call) =>
      call.sql.includes("DELETE FROM signup_slots"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.args).toContain("slt-remove");
    expect(
      statements.some(
        (call) =>
          call.sql.includes("DELETE FROM signup_slots") &&
          call.args.includes("slt-keep"),
      ),
    ).toBe(false);
  });

  it("updates a slot in place by id instead of deleting and reinserting it", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlot = {
      id: "slt-1",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        const call = { sql, args: [] as unknown[] };
        statements.push(call);
        return {
          sql,
          bind(...args: unknown[]) {
            call.args = args;
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [storedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-1",
            position: 0,
            label: "Hot dog rolls",
            quantityNeeded: 4,
            notes: null,
          },
        ],
      },
      formRow.revision,
      "admin-1",
    );
    expect(
      statements.some((call) => call.sql.includes("DELETE FROM signup_slots")),
    ).toBe(false);
    const updates = statements.filter((call) =>
      call.sql.includes("UPDATE signup_slots"),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toContain("Hot dog rolls");
    expect(updates[0]?.args).toContain(4);
  });

  it("removes every slot when the form type switches from items to rsvp", async () => {
    // validateSignupFormInput forces slots: [] for formType "rsvp"
    // (signups.ts:238-239), so this is the one case that is still fully
    // destructive by nature, not by a wholesale-replace bug: there is
    // nothing left for any slot id to match, so every existing slot is a
    // removal.
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlots = [
      {
        id: "slt-1",
        form_id: "frm-1",
        position: 0,
        label: "Hot dog buns",
        quantity_needed: 3,
        notes: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "slt-2",
        form_id: "frm-1",
        position: 1,
        label: "Drinks",
        quantity_needed: 2,
        notes: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    const db = {
      prepare: (sql: string) => {
        const call = { sql, args: [] as unknown[] };
        statements.push(call);
        return {
          sql,
          bind(...args: unknown[]) {
            call.args = args;
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: storedSlots }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      { ...formInput, formType: "rsvp", slots: [] },
      formRow.revision,
      "admin-1",
    );
    const deletes = statements.filter((call) =>
      call.sql.includes("DELETE FROM signup_slots"),
    );
    expect(deletes).toHaveLength(2);
    expect(deletes.map((call) => call.args[0])).toEqual(
      expect.arrayContaining(["slt-1", "slt-2"]),
    );
    expect(
      statements.some((call) => call.sql.includes("INSERT INTO signup_slots")),
    ).toBe(false);
  });

  it("rejects a losing racer without touching slots (TOCTOU guard)", async () => {
    // Two volunteers both read revision 2 and pass the pre-check. The
    // winner's guarded UPDATE already bumped the row to revision 3, so this
    // racer's WHERE-guarded UPDATE matches zero rows. That must be detected
    // from meta.changes before any slot statement runs — otherwise the
    // unconditional DELETE/INSERT would still fire and destroy the winner's
    // slots (and, via ON DELETE CASCADE, its claims).
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => formRow,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
      },
      batch,
    };
    await expect(
      updateSignupForm(
        { DB: db } as unknown as SignupBindings,
        "frm-1",
        formInput,
        formRow.revision,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(SignupConflictError);
    expect(batch).not.toHaveBeenCalled();
    expect(statements.some((sql) => sql.includes("DELETE FROM signup_slots"))).toBe(
      false,
    );
  });
});

describe("event reference errors", () => {
  it("maps a foreign-key violation on create to a validation error, not a throw-through", async () => {
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => null,
      }),
      batch: async () => {
        throw new Error("D1_ERROR: FOREIGN KEY constraint failed");
      },
    };
    await expect(
      createSignupForm(
        { DB: db } as unknown as SignupBindings,
        formInput,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(SignupRequestError);
  });

  it("maps a foreign-key violation on update to a validation error, not a throw-through", async () => {
    // event_id is written in phase 1 — the guarded revision bump, a standalone
    // .run() — not in the phase-2 batch(). So a stale eventId surfaces from
    // that .run(), and the mock has to throw from there or the test only proves
    // the mapping works for some *other* FK violation (a slot's form_id, say).
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        first: async () => formRow,
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.includes("UPDATE signup_forms")) {
            throw new Error("D1_ERROR: FOREIGN KEY constraint failed");
          }
          return { meta: { changes: 1 } };
        },
      }),
      batch,
    };
    await expect(
      updateSignupForm(
        { DB: db } as unknown as SignupBindings,
        "frm-1",
        formInput,
        formRow.revision,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(SignupRequestError);
    // Proof the rejection came from phase 1 rather than the batch.
    expect(batch).not.toHaveBeenCalled();
  });
});
