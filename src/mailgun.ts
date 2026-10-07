export type MailgunBindings = {
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_API_ORIGIN?: string;
};

type MailgunMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string | undefined;
};

export class MailgunDeliveryError extends Error {
  constructor(readonly status?: number) {
    super(
      status === undefined
        ? "Mailgun request failed."
        : `Mailgun rejected the email (${status}).`,
    );
    this.name = "MailgunDeliveryError";
  }
}

export async function sendMailgunEmail(
  env: MailgunBindings,
  message: MailgunMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) {
    throw new Error("Mailgun email is not configured.");
  }
  const body = new FormData();
  body.set("from", message.from);
  body.set("to", message.to);
  body.set("subject", message.subject);
  body.set("text", message.text);
  body.set("html", message.html);
  body.set("o:tracking", "no");
  body.set("o:tracking-clicks", "no");
  body.set("o:tracking-opens", "no");
  if (message.replyTo) body.set("h:Reply-To", message.replyTo);

  const apiOrigin = (env.MAILGUN_API_ORIGIN ?? "https://api.mailgun.net").replace(
    /\/$/,
    "",
  );
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiOrigin}/v3/${encodeURIComponent(env.MAILGUN_DOMAIN)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` },
        body,
        redirect: "error",
      },
    );
  } catch {
    // Provider/network errors can contain credentials or magic links.
    throw new MailgunDeliveryError();
  }
  if (!response.ok) throw new MailgunDeliveryError(response.status);
}
