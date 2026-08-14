import type { SignupBindings } from "./signups";

export type SignupEmailOptions = {
  name: string;
  formTitle: string;
  linkUrl: string;
  closesAt: string | null;
};

const deadlineFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "long",
  day: "numeric",
  year: "numeric",
});

export function signupLinkUrl(env: SignupBindings, token: string): string {
  const origin = env.PUBLIC_SITE_ORIGIN ?? "https://www.macon170.com";
  return `${origin}/signups/edit/?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSignupEmail(options: SignupEmailOptions): {
  subject: string;
  text: string;
  html: string;
} {
  const deadline = options.closesAt
    ? deadlineFormat.format(new Date(options.closesAt))
    : null;
  const deadlineLine = deadline ? `Sign up by ${deadline}.` : "";

  const text = [
    `Hi ${options.name},`,
    "",
    `Thanks for signing up for ${options.formTitle}.`,
    "",
    "Use this link to confirm your signup and to change it later:",
    options.linkUrl,
    "",
    "Keep the link. It is the only way to update your response.",
    deadlineLine,
    "",
    "Pack 170",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(`Confirm your ${options.formTitle} signup`)}</title></head>
<body style="margin:0;background:#f7f1e3;color:#272b2e;font-family:'Segoe UI',Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f1e3"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#fffdf7;border-top:8px solid #fcd116">
      <tr><td style="padding:26px 36px;background:#002b5c;color:#fff"><strong style="font-family:Montserrat,Arial,sans-serif">CUB SCOUT PACK 170</strong><br><span style="color:#dbeaf8">Macon, Georgia</span></td></tr>
      <tr><td style="padding:32px 36px">
        <p style="font-size:17px;line-height:1.55">Hi ${escapeHtml(options.name)},</p>
        <h1 style="color:#003f87;font-family:Montserrat,Arial,sans-serif;font-size:30px;line-height:1.2">Confirm your signup</h1>
        <p style="font-size:17px;line-height:1.55">Thanks for signing up for ${escapeHtml(options.formTitle)}.</p>
        <p style="margin:28px 0"><a href="${escapeHtml(options.linkUrl)}" style="display:inline-block;background:#003f87;color:#fff;font-weight:700;padding:14px 20px;text-decoration:none;border-radius:9px 9px 3px 9px">Confirm or edit your signup</a></p>
        <p style="font-size:17px;line-height:1.55">Keep this link. It is the only way to update your response.</p>
        ${deadline ? `<p style="font-size:17px;line-height:1.55">Sign up by ${escapeHtml(deadline)}.</p>` : ""}
        <p style="font-size:17px;line-height:1.55">Pack 170</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return {
    subject: `Confirm your ${options.formTitle} signup`,
    text,
    html,
  };
}

export async function sendSignupLinkEmail(
  env: SignupBindings,
  recipient: { email: string; name: string },
  options: SignupEmailOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN || !env.SIGNUP_FROM_EMAIL) {
    throw new Error("Mailgun signup email is not configured.");
  }

  const rendered = renderSignupEmail(options);
  const body = new FormData();
  body.set(
    "from",
    `${env.SIGNUP_FROM_NAME ?? "Pack 170 Volunteers"} <${env.SIGNUP_FROM_EMAIL}>`,
  );
  body.set("to", recipient.email);
  body.set("subject", rendered.subject);
  body.set("text", rendered.text);
  body.set("html", rendered.html);
  body.set("o:tracking", "no");
  body.set("o:tracking-clicks", "no");
  body.set("o:tracking-opens", "no");
  if (env.SIGNUP_REPLY_TO) body.set("h:Reply-To", env.SIGNUP_REPLY_TO);

  const apiOrigin = (env.MAILGUN_API_ORIGIN ?? "https://api.mailgun.net").replace(
    /\/$/,
    "",
  );
  const response = await fetchImpl(
    `${apiOrigin}/v3/${encodeURIComponent(env.MAILGUN_DOMAIN)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}`,
      },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(`Mailgun rejected the signup email (${response.status}).`);
  }
}
