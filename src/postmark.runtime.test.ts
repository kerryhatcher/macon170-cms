import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Miniflare } from "miniflare";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the actual transport in workerd; only the external provider is stubbed.
const transport = transpileModule(
  readFileSync(new URL("./postmark.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } },
).outputText;

const script = `${transport}
export default {
  async fetch() {
    try {
      await sendPostmarkEmail(
        { POSTMARK_SERVER_TOKEN: "key-runtime-test" },
        { from: "volunteers@macon170.com", to: "volunteer@example.test",
          subject: "Runtime test", text: "Test setup link", html: "Test setup link" },
      );
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: error.name, status: error.status ?? null }, { status: 502 });
    }
  },
};`;

describe("Postmark transport in the Cloudflare Worker runtime", () => {
  it.each([200, 302, 403])("handles provider status %s without following redirects", async (status) => {
    const outbound = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.postmarkapp.com/email");
      expect(request.method).toBe("POST");
      expect(request.headers.get("X-Postmark-Server-Token")).toBe("key-runtime-test");
      const body = await request.json() as Record<string, unknown>;
      expect(body.To).toBe("volunteer@example.test");
      expect(body.MessageStream).toBe("outbound");
      expect(body.TrackLinks).toBe("None");
      expect(body.TrackOpens).toBe(true);
      return Response.json({ ErrorCode: 0, Message: "OK", MessageID: "message-test", To: "volunteer@example.test", SubmittedAt: "2026-10-07T22:00:00Z" }, { status, headers: { Location: "https://redirect.example.test/" } });
    });
    const worker = new Miniflare({
      modules: true,
      compatibilityDate: "2026-07-29",
      compatibilityFlags: ["nodejs_compat"],
      script,
      outboundService: outbound,
    });
    try {
      const response = await worker.dispatchFetch("http://localhost/");
      expect(response.status).toBe(status === 200 ? 200 : 502);
      await expect(response.json()).resolves.toEqual(status === 200
        ? { success: true }
        : { error: "PostmarkDeliveryError", status });
      expect(outbound).toHaveBeenCalledOnce();
    } finally {
      await worker.dispose();
    }
  });
});
