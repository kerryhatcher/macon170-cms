import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Miniflare } from "miniflare";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, it, vi } from "vitest";

const verifier = transpileModule(
  readFileSync(new URL("./broadcast-turnstile.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
  },
).outputText.replace(/^export /gm, "");

it.each([200, 302, 403])(
  "verifies signup in workerd and rejects redirect/error status %s",
  async (status) => {
    const outbound = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      );
      expect(request.method).toBe("POST");
      const body = new URLSearchParams(await request.text());
      expect(body.get("secret")).toBe("test-secret");
      expect(body.get("response")).toBe("test-token");
      return Response.json(
        { success: true, action: "broadcast_signup", hostname: "cms.example" },
        { status, headers: { Location: "https://redirect.example.test/" } },
      );
    });
    const worker = new Miniflare({
      modules: true,
      compatibilityDate: "2026-07-29",
      compatibilityFlags: ["nodejs_compat"],
      script: `${verifier}
export default {async fetch(request){return Response.json({valid:await verifyBroadcastSignup("test-token",request,{TURNSTILE_SECRET:"test-secret",BROADCAST_ORIGIN:"https://cms.example"})});}};`,
      outboundService: outbound,
    });
    try {
      const response = await worker.dispatchFetch("http://localhost/");
      await expect(response.json()).resolves.toEqual({ valid: status === 200 });
      expect(outbound).toHaveBeenCalledOnce();
    } finally {
      await worker.dispose();
    }
  },
);
