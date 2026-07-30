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
});
