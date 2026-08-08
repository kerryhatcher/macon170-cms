import { describe, expect, it } from "vitest";

import { renderSignupAdminDetailPage } from "./signup-admin-page";

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
});
