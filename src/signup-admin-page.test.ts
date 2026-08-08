import { describe, expect, it } from "vitest";

import { renderSignupAdminDetailPage } from "./signup-admin-page";

describe("renderSignupAdminDetailPage", () => {
  it("never lets an attacker-controlled formId close the inline <script> element", () => {
    const hostile = "</script><script>alert(1)</script>";
    const html = renderSignupAdminDetailPage("csrf-token", hostile);
    expect(html).not.toContain("</script><script>");
  });
});
