import type { BroadcastBindings } from "./broadcasts";

export const BROADCAST_SIGNUP_ACTION = "broadcast_signup";

export async function verifyBroadcastSignup(
  token: unknown,
  request: Request,
  env: BroadcastBindings,
): Promise<boolean> {
  if (
    typeof token !== "string" ||
    !token.trim() ||
    token.length > 2048 ||
    !env.TURNSTILE_SECRET ||
    !env.BROADCAST_ORIGIN
  )
    return false;
  try {
    const origin = new URL(env.BROADCAST_ORIGIN);
    if (
      env.ENVIRONMENT !== "development" &&
      (origin.protocol !== "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
      return false;
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: token,
    });
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) body.set("remoteip", ip);
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    return (
      result?.success === true &&
      result.action === BROADCAST_SIGNUP_ACTION &&
      result.hostname === origin.hostname
    );
  } catch {
    // Fail closed without recording tokens, secrets, or provider response bodies.
    return false;
  }
}
