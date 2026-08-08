import { describe, expect, it } from "vitest";

import { summarizeSignupResponses } from "./signup-admin";
import type { SignupResponseDetail } from "./signups";

function response(
  overrides: Partial<SignupResponseDetail>,
): SignupResponseDetail {
  return {
    id: "rsp",
    formId: "frm-1",
    formSlug: "lego-derby-food",
    formTitle: "Lego Derby food",
    formType: "rsvp",
    email: "parent@example.com",
    familyName: "Hatcher",
    attending: true,
    adults: 2,
    children: 1,
    dietaryNotes: null,
    status: "confirmed",
    confirmedAt: "2027-01-02T00:00:00.000Z",
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    claims: [],
    ...overrides,
  };
}

describe("signup response summary", () => {
  it("counts families, headcounts, and unconfirmed responses", () => {
    const summary = summarizeSignupResponses([
      response({ id: "a" }),
      response({ id: "b", adults: 1, children: 4, status: "unconfirmed", confirmedAt: null }),
      response({ id: "c", attending: false, adults: 2, children: 2 }),
    ]);
    expect(summary).toEqual({
      families: 3,
      attending: 2,
      adults: 3,
      children: 5,
      unconfirmed: 1,
    });
  });

  it("excludes headcounts for families that are not attending", () => {
    const summary = summarizeSignupResponses([
      response({ attending: false, adults: 5, children: 5 }),
    ]);
    expect(summary.adults).toBe(0);
    expect(summary.children).toBe(0);
    expect(summary.attending).toBe(0);
  });

  it("returns zeros for an empty queue", () => {
    expect(summarizeSignupResponses([])).toEqual({
      families: 0,
      attending: 0,
      adults: 0,
      children: 0,
      unconfirmed: 0,
    });
  });
});
