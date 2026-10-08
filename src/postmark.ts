export type PostmarkBindings = {
  POSTMARK_SERVER_TOKEN?: string;
  ENVIRONMENT?: string;
};

export function isPostmarkConfigured(env: PostmarkBindings): env is PostmarkBindings & { POSTMARK_SERVER_TOKEN: string } {
  const token = env.POSTMARK_SERVER_TOKEN?.trim();
  return Boolean(token) &&
    !(env.ENVIRONMENT === "production" && token === "POSTMARK_API_TEST");
}

type PostmarkMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string | undefined;
};

export class PostmarkDeliveryError extends Error {
  constructor(readonly status?: number) {
    super(
      status === undefined
        ? "Postmark request failed."
        : `Postmark rejected the email (${status}).`,
    );
    this.name = "PostmarkDeliveryError";
  }
}

export async function sendPostmarkEmail(
  env: PostmarkBindings,
  message: PostmarkMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isPostmarkConfigured(env)) {
    throw new Error("Postmark email is not configured.");
  }
  const body = JSON.stringify({
    From: message.from,
    To: message.to,
    Subject: message.subject,
    TextBody: message.text,
    HtmlBody: message.html,
    ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
    MessageStream: "outbound",
    TrackOpens: true,
    TrackLinks: "None",
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(
      "https://api.postmarkapp.com/email",
      {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN.trim(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        // Workers supports only manual/follow. Reject redirects below rather
        // than forwarding the API credential to a redirected destination.
        redirect: "manual",
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new PostmarkDeliveryError(response.status);
    // Keep the deadline active through the body, not just response headers.
    const result: unknown = await response.json();
    if (
      typeof result !== "object" || result === null ||
      !("ErrorCode" in result) || result.ErrorCode !== 0 ||
      !("MessageID" in result) || typeof result.MessageID !== "string" ||
      !result.MessageID.trim()
    ) {
      throw new PostmarkDeliveryError();
    }
  } catch (error) {
    if (error instanceof PostmarkDeliveryError) throw error;
    // Provider/network errors can contain credentials or magic links.
    // An abort is ambiguous: the provider may already have accepted the email.
    throw new PostmarkDeliveryError();
  } finally {
    clearTimeout(deadline);
  }
}
