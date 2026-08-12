import { describe, expect, it } from "vitest";

import {
  SignupRequestError,
  hashSignupToken,
  isSignupClosed,
  issueSignupToken,
  validateSignupFormInput,
  validateSignupResponseInput,
} from "./signups";

const formInput = {
  slug: "lego-derby-food",
  eventId: "11111111-1111-4111-8111-111111111111",
  formType: "items",
  title: "Lego Derby food",
  instructions: "Claim what you can bring.",
  state: "open",
  closesAt: "2027-02-28T23:00:00-05:00",
  slots: [
    { label: "Hot dog buns", quantityNeeded: 3, notes: null },
    { label: "Drinks", quantityNeeded: 2, notes: "Caffeine free" },
  ],
};

const slots = [
  {
    id: "slot-1",
    formId: "form-1",
    position: 0,
    label: "Hot dog buns",
    quantityNeeded: 3,
    notes: null,
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
  },
];

describe("signup form validation", () => {
  it("normalizes the deadline to UTC and assigns slot positions", () => {
    const result = validateSignupFormInput(formInput);
    expect(result.closesAt).toBe("2027-03-01T04:00:00.000Z");
    expect(result.slots.map((slot) => slot.position)).toEqual([0, 1]);
    expect(result.slots[1]?.notes).toBe("Caffeine free");
  });

  it("keeps the title on one line so it cannot inject into the email subject", () => {
    const result = validateSignupFormInput({
      ...formInput,
      title: "Lego Derby food\r\nBcc: someone@example.com",
    });
    expect(result.title).not.toContain("\n");
    expect(result.title).not.toContain("\r");
    expect(result.title).toBe("Lego Derby food Bcc: someone@example.com");
  });

  it("rejects a bad slug, unknown type, and unknown state", () => {
    expect(() =>
      validateSignupFormInput({ ...formInput, slug: "Lego Derby" }),
    ).toThrow("slug");
    expect(() =>
      validateSignupFormInput({ ...formInput, formType: "potluck" }),
    ).toThrow("formType");
    expect(() =>
      validateSignupFormInput({ ...formInput, state: "archived" }),
    ).toThrow("state");
  });

  it("requires at least one slot for an items form and none for rsvp", () => {
    expect(() =>
      validateSignupFormInput({ ...formInput, slots: [] }),
    ).toThrow("at least one item");
    expect(
      validateSignupFormInput({ ...formInput, formType: "rsvp", slots: [] })
        .slots,
    ).toEqual([]);
    expect(
      validateSignupFormInput({ ...formInput, formType: "rsvp" }).slots,
    ).toEqual([]);
  });

  it("rejects a slot quantity below one", () => {
    expect(() =>
      validateSignupFormInput({
        ...formInput,
        slots: [{ label: "Buns", quantityNeeded: 0, notes: null }],
      }),
    ).toThrow("quantityNeeded");
  });

  it("passes an existing slot's id through unchanged and drops an empty one", () => {
    const result = validateSignupFormInput({
      ...formInput,
      slots: [
        { id: "slot-1", label: "Hot dog buns", quantityNeeded: 3, notes: null },
        { id: "", label: "Drinks", quantityNeeded: 2, notes: null },
      ],
    });
    expect(result.slots[0]?.id).toBe("slot-1");
    expect(result.slots[1]?.id).toBeUndefined();
  });
});

describe("signup response validation", () => {
  const base = {
    email: " Parent@Example.COM ",
    familyName: "  Hatcher  ",
    attending: true,
    adults: 2,
    children: 3,
    dietaryNotes: "Peanut allergy",
    claims: [{ slotId: "slot-1", quantity: 2 }],
  };

  it("lowercases and trims the email and keeps the dietary note", () => {
    const result = validateSignupResponseInput(base, {
      formType: "items",
      slots,
    });
    expect(result.email).toBe("parent@example.com");
    expect(result.familyName).toBe("Hatcher");
    expect(result.dietaryNotes).toBe("Peanut allergy");
  });

  it("forces attending true and drops claims for an rsvp form", () => {
    const result = validateSignupResponseInput(base, {
      formType: "rsvp",
      slots: [],
    });
    expect(result.claims).toEqual([]);
  });

  it("rejects an unknown slot id", () => {
    expect(() =>
      validateSignupResponseInput(
        { ...base, claims: [{ slotId: "nope", quantity: 1 }] },
        { formType: "items", slots },
      ),
    ).toThrow(SignupRequestError);
  });

  it("rejects a malformed email and out-of-range headcounts", () => {
    expect(() =>
      validateSignupResponseInput(
        { ...base, email: "not-an-email" },
        { formType: "items", slots },
      ),
    ).toThrow("email");
    expect(() =>
      validateSignupResponseInput(
        { ...base, adults: 99 },
        { formType: "items", slots },
      ),
    ).toThrow("adults");
    expect(() =>
      validateSignupResponseInput(
        { ...base, children: -1 },
        { formType: "items", slots },
      ),
    ).toThrow("children");
  });

  it("rejects a duplicate slot claim", () => {
    expect(() =>
      validateSignupResponseInput(
        {
          ...base,
          claims: [
            { slotId: "slot-1", quantity: 1 },
            { slotId: "slot-1", quantity: 1 },
          ],
        },
        { formType: "items", slots },
      ),
    ).toThrow("once");
  });
});

describe("signup closed state", () => {
  const at = Date.parse("2027-03-01T00:00:00.000Z");

  it("treats draft and closed states as closed", () => {
    expect(isSignupClosed({ state: "draft", closesAt: null }, at)).toBe(true);
    expect(isSignupClosed({ state: "closed", closesAt: null }, at)).toBe(true);
    expect(isSignupClosed({ state: "open", closesAt: null }, at)).toBe(false);
  });

  it("treats a passed deadline as closed", () => {
    expect(
      isSignupClosed({ state: "open", closesAt: "2027-02-28T00:00:00.000Z" }, at),
    ).toBe(true);
    expect(
      isSignupClosed({ state: "open", closesAt: "2027-03-02T00:00:00.000Z" }, at),
    ).toBe(false);
  });
});

describe("signup tokens", () => {
  it("issues a URL-safe token whose stored hash is not the token", async () => {
    const { token, tokenHash } = await issueSignupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    await expect(hashSignupToken(token)).resolves.toBe(tokenHash);
  });

  it("issues a different token each call", async () => {
    const first = await issueSignupToken();
    const second = await issueSignupToken();
    expect(first.token).not.toBe(second.token);
  });
});
