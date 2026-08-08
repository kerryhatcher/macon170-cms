import { describe, expect, it, vi } from "vitest";

import {
  createSignupResponse,
  getResponseByTokenHash,
  updateSignupResponse,
} from "./signup-store";
import { SignupSlotFullError, validateSignupResponseInput } from "./signups";
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
