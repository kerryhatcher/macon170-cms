import sanitizeHtml from "sanitize-html";
import { convert } from "html-to-text";

export function escapeEmail(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

export function sanitizeEmailHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: [
      "p",
      "div",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "h1",
      "h2",
      "h3",
      "ul",
      "ol",
      "li",
      "blockquote",
      "a",
      "span",
      "img",
      "hr",
    ],
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    allowedStyles: {
      "*": {
        color: [
          /^#[0-9a-f]{3,8}$/i,
          /^rgb\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3}\s*\)$/i,
        ],
        "background-color": [
          /^#[0-9a-f]{3,8}$/i,
          /^rgb\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3}\s*\)$/i,
        ],
        "text-align": [/^(left|right|center|justify)$/],
        "padding-left": [/^[1-8]em$/],
        "max-width": [/^100%$/],
        height: [/^auto$/],
      },
    },
    transformTags: {
      "*": (tagName, attrs) => {
        const attribs = { ...attrs };
        const align = /(?:^|\s)ql-align-(center|right|justify)(?:\s|$)/.exec(
          attribs.class ?? "",
        );
        const indent = /(?:^|\s)ql-indent-([1-8])(?:\s|$)/.exec(
          attribs.class ?? "",
        );
        if (align)
          attribs.style =
            (attribs.style ? attribs.style + ";" : "") +
            "text-align:" +
            align[1];
        if (indent)
          attribs.style =
            (attribs.style ? attribs.style + ";" : "") +
            "padding-left:" +
            indent[1] +
            "em";
        if (tagName === "a") {
          if (!/^(https?:\/\/|mailto:)/i.test(attribs.href ?? ""))
            delete attribs.href;
          attribs.target = "_blank";
          attribs.rel = "noopener noreferrer";
        }
        if (tagName === "img") {
          if (!/^https:\/\//i.test(attribs.src ?? "")) delete attribs.src;
          attribs.style = "max-width:100%;height:auto";
          for (const key of ["width", "height"])
            if (!/^\d{1,4}$/.test(attribs[key] ?? "")) delete attribs[key];
        }
        return { tagName, attribs };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

export function emailHtmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ...["h1", "h2", "h3"].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
    ],
  }).trim();
}

export function emailContent(
  subject: string,
  body: string,
  html = "",
  name = "friend",
) {
  const recipientName = name.trim().replace(/[\r\n]+/g, " ") || "friend";
  const source = html
    ? sanitizeEmailHtml(html)
    : '<div style="white-space:pre-wrap">' + escapeEmail(body) + "</div>";
  // Apply the same generic fallback for previews and the public archive. Recipient
  // values are escaped before insertion and never stored in the shared message.
  const content = source.replaceAll("{{name}}", escapeEmail(recipientName));
  return {
    subject: subject.replaceAll("{{name}}", recipientName),
    text: (html ? emailHtmlToText(source) : body).replaceAll(
      "{{name}}",
      recipientName,
    ),
    html: content,
  };
}

export function emailDocument(
  subject: string,
  content: string,
  footer = "",
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeEmail(subject)} · Pack 170</title></head><body style="margin:0;background:#f3f6f8;color:#173650;font:16px/1.6 Arial,sans-serif"><div role="article" style="max-width:640px;margin:24px auto;padding:24px;background:white;border-top:6px solid #f5c542;overflow-wrap:anywhere"><p style="font-weight:bold;color:#173650">Pack 170</p><h1 style="font-size:26px;line-height:1.3">${escapeEmail(subject)}</h1>${content}${footer}</div></body></html>`;
}
