import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Miniflare } from "miniflare";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the actual transport in workerd; only the external provider is stubbed.
const transport = transpileModule(
  readFileSync(new URL("./mailgun.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } },
).outputText;

const script = `${transport}
export default {
  async fetch() {
    try {
      await sendMailgunEmail(
        { MAILGUN_API_KEY: "key-runtime-test", MAILGUN_DOMAIN: "macon170.com" },
        { from: "volunteers@macon170.com", to: "volunteer@example.test",
          subject: "Runtime test", text: "Test setup link", html: "Test setup link" },
      );
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: error.name, status: error.status ?? null }, { status: 502 });
    }
  },
};`;

describe("Mailgun transport in the Cloudflare Worker runtime", () => {
  it.each([200, 302, 403])("handles provider status %s without following redirects", async (status) => {
    const outbound = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.mailgun.net/v3/macon170.com/messages");
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe(`Basic ${btoa("api:key-runtime-test")}`);
      const body = await request.formData();
      expect(body.get("to")).toBe("volunteer@example.test");
      expect(body.get("o:tracking")).toBe("no");
      return new Response(null, { status, headers: { Location: "https://redirect.example.test/" } });
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
        : { error: "MailgunDeliveryError", status });
      expect(outbound).toHaveBeenCalledOnce();
    } finally {
      await worker.dispose();
    }
  });
});
