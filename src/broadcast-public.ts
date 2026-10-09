import { emailContent, emailDocument } from "./broadcast-email";
import {
  BroadcastError,
  emailAddress,
  escape,
  json,
  readInput,
  signedToken,
  verifyToken,
  type BroadcastBindings,
} from "./broadcasts";
import {
  sendPostmarkEmail,
  isPostmarkConfigured,
  PostmarkDeliveryError,
} from "./postmark";

export function publicPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escape(title)} · Pack 170</title><style>body{font:18px/1.6 system-ui;max-width:640px;margin:3rem auto;padding:1rem;color:#163452}label{display:block;margin:1rem 0}input:not([type=checkbox]),button{font:inherit;padding:.6rem;max-width:100%;box-sizing:border-box}button{background:#153956;color:white;border:0;border-radius:5px;cursor:pointer}</style><h1>${escape(title)}</h1>${body}</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}
export async function handleBroadcastPublic(
  request: Request,
  env: BroadcastBindings,
): Promise<Response> {
  try {
    const url = new URL(request.url),
      path = url.pathname;
    if (!["GET", "POST"].includes(request.method))
      return json({ message: "Method not allowed." }, 405);
    if (path.startsWith("/email/messages/")) {
      if (request.method !== "GET")
        return json({ message: "Method not allowed." }, 405);
      const id = path.slice("/email/messages/".length);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        return json({ message: "Email not found." }, 404);
      const message = await env.DB.prepare(
        "SELECT subject,body,body_html FROM broadcasts b WHERE id=? AND state!='draft' AND EXISTS(SELECT 1 FROM broadcast_recipients r WHERE r.broadcast_id=b.id AND r.message_id IS NOT NULL)",
      )
        .bind(id)
        .first<{ subject: string; body: string; body_html: string }>();
      if (!message) return json({ message: "Email not found." }, 404);
      const content = emailContent(
        message.subject,
        message.body,
        message.body_html,
      );
      return new Response(emailDocument(content.subject, content.html), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; img-src https:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }
    const oneClick = path.startsWith("/email/unsubscribe/");
    if (
      request.method === "POST" &&
      !oneClick &&
      request.headers.get("Origin") !== url.origin
    )
      return json({ message: "Origin rejected." }, 403);
    if (path.startsWith("/email/signup/")) {
      const list = await env.DB.prepare(
        "SELECT id,name FROM broadcast_lists WHERE slug=?",
      )
        .bind(path.slice("/email/signup/".length))
        .first<{ id: string; name: string }>();
      if (!list)
        return publicPage(
          "List not found",
          "<p>This signup link is unavailable.</p>",
        );
      if (request.method === "GET")
        return publicPage(
          `Join ${list.name}`,
          `<p>Receive Pack 170 updates. We will email a confirmation link before adding you to this list. You can unsubscribe at any time.</p><form method="post"><label>Your name <input name="name" maxlength="100" autocomplete="name"></label><label>Email <input type="email" name="email" required maxlength="254" autocomplete="email"></label><label><input type="checkbox" name="consent" value="yes" required> I want to receive emails from this list.</label><button>Send confirmation</button></form>`,
        );
      if (
        !env.SIGNUP_RATE_LIMITER ||
        !isPostmarkConfigured(env) ||
        !env.BROADCAST_FROM_EMAIL ||
        !env.BROADCAST_ORIGIN
      )
        return json({ message: "Signup is temporarily unavailable." }, 503);
      const limited = await env.SIGNUP_RATE_LIMITER.limit({
        key: `broadcast:${request.headers.get("CF-Connecting-IP") ?? "local"}`,
      });
      if (!limited.success)
        return json({ message: "Please wait before trying again." }, 429);
      const input = await readInput(request),
        email = emailAddress(input.email);
      if (input.consent !== "yes")
        throw new BroadcastError(
          "Please confirm that you want to join this list.",
        );
      const name =
        typeof input.name === "string" ? input.name.slice(0, 100) : "";
      await env.DB.prepare(
        "INSERT OR IGNORE INTO broadcast_contacts(id,email,name,created_at) VALUES(?,?,?,?)",
      )
        .bind(crypto.randomUUID(), email, name, Date.now())
        .run();
      const contact = await env.DB.prepare(
        "SELECT id,tag FROM broadcast_contacts WHERE email=?",
      )
        .bind(email)
        .first<{ id: string; tag: string }>();
      const recent =
        contact &&
        (await env.DB.prepare(
          "SELECT id FROM broadcast_confirmations WHERE contact_id=? AND list_id=? AND expires_at>? LIMIT 1",
        )
          .bind(contact.id, list.id, Date.now() + 23 * 3600000)
          .first());
      const member =
        contact &&
        (await env.DB.prepare(
          "SELECT contact_id FROM broadcast_memberships WHERE contact_id=? AND list_id=? AND state='active'",
        )
          .bind(contact.id, list.id)
          .first());
      if (contact && !contact.tag && !recent && !member) {
        const confirmation = crypto.randomUUID();
        // Reserve atomically so concurrent signup requests cannot send duplicate confirmations.
        const reservation = await env.DB.prepare(
          `INSERT INTO broadcast_confirmations(id,contact_id,list_id,expires_at)
           SELECT ?,?,?,? WHERE NOT EXISTS (
             SELECT 1 FROM broadcast_confirmations WHERE contact_id=? AND list_id=? AND expires_at>?
           )`,
        )
          .bind(
            confirmation,
            contact.id,
            list.id,
            Date.now() + 86400000,
            contact.id,
            list.id,
            Date.now() + 23 * 3600000,
          )
          .run();
        if (!reservation.meta.changes)
          return publicPage(
            "Check your email",
            "<p>If this address is eligible, we sent a confirmation link. Your subscription starts after you confirm.</p>",
          );
        const token = await signedToken(env, `confirm:${confirmation}`);
        const link = `${env.BROADCAST_ORIGIN}/email/confirm/${token}`;
        try {
          await sendPostmarkEmail(env, {
            from: env.BROADCAST_FROM_EMAIL,
            to: email,
            subject: `Confirm your Pack 170 subscription`,
            text: `Confirm your subscription to ${list.name}: ${link}\nThis link expires in 24 hours. Ignore this message if you did not request it.`,
            html: `<p>Confirm your subscription to ${escape(list.name)}.</p><p><a href="${escape(link)}">Confirm subscription</a></p><p>This link expires in 24 hours. Ignore it if you did not request it.</p>`,
          });
        } catch (error) {
          if (
            error instanceof PostmarkDeliveryError &&
            error.status !== undefined &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408
          ) {
            await env.DB.prepare(
              "DELETE FROM broadcast_confirmations WHERE id=?",
            )
              .bind(confirmation)
              .run();
          }
          throw error;
        }
      }
      return publicPage(
        "Check your email",
        "<p>If this address is eligible, we sent a confirmation link. Your subscription starts after you confirm.</p>",
      );
    }
    const token = path.split("/")[3] ?? "";
    const payload = await verifyToken(env, token);
    if (!payload) return json({ message: "Invalid link." }, 404);
    const [purpose, contact, list] = payload.split(":");
    if (path.startsWith("/email/confirm/") && purpose === "confirm") {
      const confirmation = await env.DB.prepare(
        "SELECT id FROM broadcast_confirmations WHERE id=? AND expires_at>?",
      )
        .bind(contact, Date.now())
        .first();
      if (!confirmation)
        return json(
          { message: "This confirmation link is expired or already used." },
          404,
        );
      if (request.method === "GET")
        return publicPage(
          "Confirm subscription",
          '<form method="post"><button>Confirm my subscription</button></form>',
        );
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO broadcast_memberships(contact_id,list_id,state)
    SELECT f.contact_id,f.list_id,'active' FROM broadcast_confirmations f JOIN broadcast_contacts c ON c.id=f.contact_id
    WHERE f.id=? AND f.expires_at>? AND c.tag=''
    ON CONFLICT(contact_id,list_id) DO UPDATE SET state='active'`,
        ).bind(contact, Date.now()),
        env.DB.prepare("DELETE FROM broadcast_confirmations WHERE id=?").bind(
          contact,
        ),
      ]);
      return publicPage(
        "Subscription confirmed",
        "<p>You are subscribed. Every email includes a link to manage your lists.</p>",
      );
    }
    if (oneClick && purpose === "unsubscribe") {
      if (request.method === "GET")
        return publicPage(
          "Unsubscribe",
          '<form method="post"><button>Unsubscribe from this list</button></form>',
        );
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE broadcast_memberships SET state='unsubscribed' WHERE contact_id=? AND list_id=?",
        ).bind(contact, list),
        env.DB.prepare(
          "DELETE FROM broadcast_confirmations WHERE contact_id=? AND list_id=?",
        ).bind(contact, list),
      ]);
      return publicPage(
        "Unsubscribed",
        "<p>You will no longer receive emails from this list.</p>",
      );
    }
    if (path.startsWith("/email/preferences/") && purpose === "preferences") {
      const memberships = await env.DB.prepare(
        "SELECT l.id,l.name FROM broadcast_lists l JOIN broadcast_memberships m ON m.list_id=l.id WHERE m.contact_id=? AND m.state='active'",
      )
        .bind(contact)
        .all<{ id: string; name: string }>();
      if (request.method === "POST") {
        const input = await readInput(request);
        const selected = memberships.results.filter(
          (l) => input[`list_${l.id}`] === "yes",
        );
        if (input.all === "yes") {
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE broadcast_contacts SET tag='unsubscribed' WHERE id=? AND tag=''",
            ).bind(contact),
            env.DB.prepare(
              "UPDATE broadcast_memberships SET state='unsubscribed' WHERE contact_id=?",
            ).bind(contact),
            env.DB.prepare(
              "DELETE FROM broadcast_confirmations WHERE contact_id=?",
            ).bind(contact),
          ]);
        } else if (selected.length) {
          await env.DB.batch(
            selected.flatMap((l) => [
              env.DB.prepare(
                "UPDATE broadcast_memberships SET state='unsubscribed' WHERE contact_id=? AND list_id=?",
              ).bind(contact, l.id),
              env.DB.prepare(
                "DELETE FROM broadcast_confirmations WHERE contact_id=? AND list_id=?",
              ).bind(contact, l.id),
            ]),
          );
        } else throw new BroadcastError("Select at least one list.");
        return publicPage(
          "Preferences saved",
          `<p>You have been unsubscribed from the selected lists.</p><a href="${escape(url.pathname)}">Manage remaining lists</a>`,
        );
      }
      return publicPage(
        "Your email preferences",
        `<p>Select the lists you want to unsubscribe from.</p><form method="post">${memberships.results.map((l) => `<label><input type="checkbox" name="list_${escape(l.id)}" value="yes"> ${escape(l.name)}</label>`).join("")}<label><input type="checkbox" name="all" value="yes"> Unsubscribe from all current and future broadcasts</label><button>Unsubscribe</button></form>`,
      );
    }
    return json({ message: "This link is invalid or expired." }, 404);
  } catch (error) {
    return json(
      {
        message:
          error instanceof BroadcastError
            ? error.message
            : "Unable to complete this request. Please try again later.",
      },
      error instanceof BroadcastError ? 400 : 503,
    );
  }
}
