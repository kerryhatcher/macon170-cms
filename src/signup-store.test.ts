import { describe, expect, it, vi } from "vitest";

import { getPublicSignupForm, updateSignupForm } from "./signup-store";
import { SignupConflictError, validateSignupFormInput } from "./signups";
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

  it("bumps the revision and replaces slots in one batch", async () => {
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    // The pre-write conflict check must see the *current* revision (matching
    // expectedRevision); only the post-write re-fetch should see the bump.
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
    expect(statements.some((sql) => sql.includes("DELETE FROM signup_slots"))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes("INSERT INTO signup_audit"))).toBe(
      true,
    );
    expect(updated.revision).toBe(3);
  });
});
