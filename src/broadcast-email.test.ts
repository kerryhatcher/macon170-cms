import { expect, it } from "vitest";
import {
  sanitizeEmailHtml,
  emailContent,
  emailHtmlToText,
} from "./broadcast-email";
it("keeps email formatting and converts editor alignment to inline styles", () => {
  const html = sanitizeEmailHtml(
    '<h2>News</h2><p class="ql-align-center"><strong>Hello</strong> <em>Pack</em></p><ul><li>Meet Saturday</li></ul><img src="https://example.test/photo.jpg" onerror="alert(1)">',
  );
  expect(html).toContain("<h2>News</h2>");
  expect(html).toContain("text-align:center");
  expect(html).toContain("<ul><li>Meet Saturday</li></ul>");
  expect(html).not.toContain("onerror");
  expect(emailHtmlToText(html)).toContain("Hello Pack");
});
it("removes executable markup, unsafe URLs, foreign content, and arbitrary CSS", () => {
  const html = sanitizeEmailHtml(
    '<script>alert(1)</script><iframe src="https://evil.test"></iframe><form><input autofocus onfocus="alert(1)"></form><p style="color:#123456;background-image:url(https://evil.test);position:fixed">Safe</p><a href="&#106;avascript:alert(1)">link</a><img src="data:image/svg+xml,evil"><svg><xmp><img src=x onerror=alert(1)></xmp></svg>',
  );
  expect(html).not.toMatch(
    /<script|<iframe|<form|<input|<svg|<xmp|onerror|javascript:|data:|position:|background-image/i,
  );
  expect(html).toContain("Safe");
  expect(html).toContain("color:#123456");
});
it("uses escaped recipient names only in individual messages and generic names otherwise", () => {
  const source = "<p>Hi {{name}}, welcome!</p>";
  const privateMessage = emailContent(
    "Hello {{name}}",
    "",
    source,
    "Alex <Parent>",
  );
  expect(privateMessage.html).toContain("Alex &lt;Parent&gt;");
  expect(privateMessage.subject).toBe("Hello Alex <Parent>");
  const publicMessage = emailContent("Hello {{name}}", "", source);
  expect(publicMessage.html).toContain("Hi friend,");
  expect(publicMessage.subject).toBe("Hello friend");
  expect(publicMessage.html).not.toContain("Alex");
});
