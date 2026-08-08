import { describe, expect, it, vi } from "vitest";

import {
  confirmSignupResponse,
  createSignupResponse,
  deleteSignupResponse,
  getResponseByTokenHash,
  rotateResponseToken,
  updateSignupResponse,
} from "./signup-store";
import {
  SignupConflictError,
  SignupSlotFullError,
  validateSignupResponseInput,
} from "./signups";
import type { SignupBindings, SignupFormDetail } from "./signups";

const form: SignupFormDetail = {
  id: "frm-1",
  revision: 0,
  slug: "lego-derby-food",
  eventId: "evt-1",
  formType: "items",
  title: "Lego Derby food",
  instructions: "",
  state: "open",
  closesAt: null,
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-01-01T00:00:00.000Z",
  slots: [
    {
      id: "slt-1",
      formId: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantityNeeded: 3,
      notes: null,
      createdAt: "2027-01-01T00:00:00.000Z",
      updatedAt: "2027-01-01T00:00:00.000Z",
    },
  ],
};

const input = validateSignupResponseInput(
  {
    email: "parent@example.com",
    familyName: "Hatcher",
    attending: true,
    adults: 2,
    children: 1,
    dietaryNotes: "Peanut allergy",
    claims: [{ slotId: "slt-1", quantity: 2 }],
  },
  form,
);

function dbWithBatch(batch: ReturnType<typeof vi.fn>) {
  return {
    prepare: (sql: string) => ({
      sql,
      bind() {
        return this;
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    batch,
  };
}

describe("signup response creation", () => {
  it("stores the response, its claims, and an audit row in one batch", async () => {
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
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
      batch,
    };
    const id = await createSignupResponse(
      { DB: db } as unknown as SignupBindings,
      form,
      input,
      "hash-1",
      "ip-hash",
    );
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(batch).toHaveBeenCalledOnce();
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_responses")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_claims")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(true);
  });

  it("translates the capacity trigger abort into SignupSlotFullError", async () => {
    const batch = vi
      .fn()
      .mockRejectedValue(new Error("D1_ERROR: signup slot is full"));
    await expect(
      createSignupResponse(
        { DB: dbWithBatch(batch) } as unknown as SignupBindings,
        form,
        input,
        "hash-1",
        null,
      ),
    ).rejects.toBeInstanceOf(SignupSlotFullError);
  });

  it("translates a composite-UNIQUE(form_id, email) violation into SignupConflictError", async () => {
    const batch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: signup_responses.form_id, signup_responses.email",
        ),
      );
    await expect(
      createSignupResponse(
        { DB: dbWithBatch(batch) } as unknown as SignupBindings,
        form,
        input,
        "hash-1",
        null,
      ),
    ).rejects.toBeInstanceOf(SignupConflictError);
  });

  it("does not let the slot-full and duplicate-email predicates cross-swallow each other", async () => {
    const slotFullBatch = vi
      .fn()
      .mockRejectedValue(new Error("D1_ERROR: signup slot is full"));
    const slotFullResult = createSignupResponse(
      { DB: dbWithBatch(slotFullBatch) } as unknown as SignupBindings,
      form,
      input,
      "hash-1",
      null,
    );
    await expect(slotFullResult).rejects.toBeInstanceOf(SignupSlotFullError);
    await expect(slotFullResult).rejects.not.toBeInstanceOf(
      SignupConflictError,
    );

    const duplicateBatch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: signup_responses.form_id, signup_responses.email",
        ),
      );
    const duplicateResult = createSignupResponse(
      { DB: dbWithBatch(duplicateBatch) } as unknown as SignupBindings,
      form,
      input,
      "hash-1",
      null,
    );
    await expect(duplicateResult).rejects.toBeInstanceOf(SignupConflictError);
    await expect(duplicateResult).rejects.not.toBeInstanceOf(
      SignupSlotFullError,
    );
  });
});

describe("signup response updates", () => {
  it("replaces claims and surfaces a full slot as SignupSlotFullError", async () => {
    const batch = vi
      .fn()
      .mockRejectedValue(new Error("D1_ERROR: signup slot is full"));
    await expect(
      updateSignupResponse(
        { DB: dbWithBatch(batch) } as unknown as SignupBindings,
        "rsp-1",
        input,
      ),
    ).rejects.toBeInstanceOf(SignupSlotFullError);
  });
});

describe("signup response confirmation", () => {
  it("writes exactly one audit row when confirming an unconfirmed response", async () => {
    const statements: string[] = [];
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
    };
    await confirmSignupResponse({ DB: db } as unknown as SignupBindings, "rsp-1");
    expect(
      statements.filter((sql) => sql.includes("INSERT INTO signup_audit"))
        .length,
    ).toBe(1);
  });

  it("does not write an audit row when the response is already confirmed", async () => {
    const statements: string[] = [];
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          run: async () => ({ meta: { changes: 0 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
    };
    await confirmSignupResponse({ DB: db } as unknown as SignupBindings, "rsp-1");
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(false);
  });
});

describe("token lookup", () => {
  it("returns null for an unknown hash", async () => {
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
      getResponseByTokenHash(
        { DB: db } as unknown as SignupBindings,
        "nope",
      ),
    ).resolves.toBeNull();
  });

  it("maps a row plus its claims into a detail object", async () => {
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () => ({
          id: "rsp-1",
          form_id: "frm-1",
          email: "parent@example.com",
          family_name: "Hatcher",
          attending: 1,
          adults: 2,
          children: 1,
          dietary_notes: "Peanut allergy",
          status: "unconfirmed",
          confirmed_at: null,
          created_at: 1,
          updated_at: 1,
          form_slug: "lego-derby-food",
          form_title: "Lego Derby food",
          form_type: "items",
        }),
        all: async () => ({
          results: [{ slot_id: "slt-1", label: "Hot dog buns", quantity: 2 }],
        }),
      }),
    };
    const detail = await getResponseByTokenHash(
      { DB: db } as unknown as SignupBindings,
      "hash-1",
    );
    expect(detail).toMatchObject({
      id: "rsp-1",
      attending: true,
      status: "unconfirmed",
      claims: [{ slotId: "slt-1", label: "Hot dog buns", quantity: 2 }],
    });
  });
});

describe("response deletion and token rotation", () => {
  function dbWithRuns(changes: number[]) {
    const statements: string[] = [];
    let call = 0;
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          run: async () => ({ meta: { changes: changes[call++] ?? 0 } }),
        };
      },
    };
    return { db, statements };
  }

  it("writes the deleted audit row only when a row was actually removed", async () => {
    const removed = dbWithRuns([1, 1]);
    await deleteSignupResponse(
      { DB: removed.db } as unknown as SignupBindings,
      "rsp-1",
      "admin-1",
    );
    expect(
      removed.statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(true);
  });

  it("skips the audit row when the delete matched nothing", async () => {
    // Two actors racing to withdraw the same response: only one deletion
    // happened, so only one audit row may exist.
    const missing = dbWithRuns([0]);
    await deleteSignupResponse(
      { DB: missing.db } as unknown as SignupBindings,
      "rsp-1",
      null,
    );
    expect(
      missing.statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(false);
  });

  it("reports whether the token rotation matched a row", async () => {
    const batch = vi
      .fn()
      .mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
    await expect(
      rotateResponseToken(
        { DB: dbWithBatch(batch) } as unknown as SignupBindings,
        "rsp-1",
        "hash-1",
        null,
      ),
    ).resolves.toBe(true);

    const gone = vi
      .fn()
      .mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 1 } }]);
    await expect(
      rotateResponseToken(
        { DB: dbWithBatch(gone) } as unknown as SignupBindings,
        "rsp-1",
        "hash-1",
        null,
      ),
    ).resolves.toBe(false);
  });
});
