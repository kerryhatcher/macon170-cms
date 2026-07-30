import { describe, expect, it } from "vitest";

import { renderLeadershipPage } from "./leadership-page";

describe("renderLeadershipPage", () => {
  it("renders a syntactically valid roster script", () => {
    const page = renderLeadershipPage("test-csrf-token");
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      ([, script]) => script,
    );

    expect(scripts).not.toHaveLength(0);
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("safely embeds the CSRF token and preserves vacant names as strings", () => {
    const page = renderLeadershipPage("</script><script>alert(1)</script>");

    expect(page).toContain("\\u003c/script>");
    expect(page).not.toContain("const CSRF=</script>");
    expect(page).toContain('name:document.querySelector("#field-name").value');
    expect(page).not.toContain('name:document.querySelector("#field-name").value||null');
    expect(page).toContain("'\"':\"&quot;\"");
  });
});
