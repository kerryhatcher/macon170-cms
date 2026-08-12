import { describe, expect, it } from "vitest";

import {
  countClaimedFamiliesBySlot,
  diffRemovedSlotIds,
  renderSignupAdminPage,
  renderSignupAdminDetailPage,
} from "./signup-admin-page";

describe("diffRemovedSlotIds", () => {
  it("returns loaded ids missing from the current rows", () => {
    expect(
      diffRemovedSlotIds(["a", "b", "c"], [{ id: "a" }, { id: "c" }]),
    ).toEqual(["b"]);
  });

  it("treats a brand-new row with no id as neither removed nor kept", () => {
    expect(diffRemovedSlotIds(["a"], [{ id: "a" }, {}])).toEqual([]);
  });

  it("returns every loaded id when the current list is empty", () => {
    expect(diffRemovedSlotIds(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("countClaimedFamiliesBySlot", () => {
  it("counts one per distinct response per slot, not claimed quantity", () => {
    const responses = [
      { claims: [{ slotId: "slot-1" }, { slotId: "slot-2" }] },
      { claims: [{ slotId: "slot-1" }] },
    ];
    expect(countClaimedFamiliesBySlot(responses)).toEqual({
      "slot-1": 2,
      "slot-2": 1,
    });
  });

  it("returns an empty object when nothing has claims", () => {
    expect(countClaimedFamiliesBySlot([])).toEqual({});
  });
});

describe("renderSignupAdminPage", () => {
  it("links to the new-signup route", () => {
    const html = renderSignupAdminPage("csrf-token");
    expect(html).toContain('href="/admin/signups/new"');
  });
});

describe("renderSignupAdminDetailPage", () => {
  it("never lets an attacker-controlled formId close the inline <script> element", () => {
    const hostile = "</script><script>alert(1)</script>";
    const html = renderSignupAdminDetailPage("csrf-token", hostile);
    expect(html).not.toContain("</script><script>");
  });

  it("escapes the CSRF token interpolation too", () => {
    // Same scriptSafeJson choke point, second call site. A mutation there
    // breaks both, so both need a case or one of them proves nothing.
    const html = renderSignupAdminDetailPage(
      "</script><script>alert(2)</script>",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).not.toContain("</script><script>");
  });

  it("renders the settings panel with the event picker and a hidden slot editor", () => {
    const html = renderSignupAdminDetailPage(
      "csrf-token",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('id="event-select"');
    expect(html).toContain('id="slot-editor"');
  });

  it("renders create mode without a form id and without a response section", () => {
    const html = renderSignupAdminDetailPage("csrf-token", null);
    expect(html).toContain("New signup form");
    expect(html).toContain("Create signup");
    expect(html).not.toContain('id="responses-section"');
  });
});
