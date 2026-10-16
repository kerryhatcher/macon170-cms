import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("preview Wrangler template", () => {
  it("is strict JSON so the config generator can parse it", async () => {
    const config = JSON.parse(await readFile("wrangler.preview.jsonc", "utf8"));

    expect(config.name).toBe("macon170-cms-preview-placeholder");
    expect(config.d1_databases[0].database_id).toBe("replace-at-deploy");
  });
});
