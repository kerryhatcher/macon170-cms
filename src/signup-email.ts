import type { SignupBindings } from "./signups";

export type SignupEmailOptions = {
  familyName: string;
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

  const html = [
    `<p>Thanks for signing up for ${escapeHtml(options.formTitle)}.</p>`,
    `<p><a href="${escapeHtml(options.linkUrl)}">Confirm your signup for ${escapeHtml(options.formTitle)}</a></p>`,
    "<p>Keep this link. It is the only way to update your response.</p>",
    deadline ? `<p>Sign up by ${escapeHtml(deadline)}.</p>` : "",
    `<p>Thanks, ${escapeHtml(options.familyName)} — Pack 170</p>`,
  ]
    .filter(Boolean)
    .join("\n");

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
): Promise<void> {
  if (!env.EMAIL || !env.INVITE_FROM_EMAIL) {
    throw new Error("The signup email binding is not configured.");
  }
  const rendered = renderSignupEmail(options);
  const message: EmailMessageBuilder = {
    from: {
      email: env.INVITE_FROM_EMAIL,
      name: env.INVITE_FROM_NAME ?? "Pack 170 Volunteers",
    },
    to: { email: recipient.email, name: recipient.name },
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  };
  if (env.INVITE_REPLY_TO) message.replyTo = env.INVITE_REPLY_TO;
  await env.EMAIL.send(message);
}
