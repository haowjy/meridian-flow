// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { sanitizePastedHTML } from "./sanitize-paste";

describe("sanitizePastedHTML", () => {
  it("removes executable elements, styles, forms, and event handlers", () => {
    const sanitized = sanitizePastedHTML(`
      <p onclick="alert(1)" style="color: red">Safe</p>
      <script>alert(1)</script><style>body { display: none }</style>
      <iframe src="https://example.com">frame</iframe>
      <embed src="https://example.com"><object data="x">object</object>
      <form action="/steal"><input name="secret" value="x">form</form>
    `);

    expect(sanitized).toContain("<p>Safe</p>");
    expect(sanitized).not.toMatch(/script|style=|onclick|iframe|embed|object|form|input/i);
    expect(sanitized).not.toContain("alert(1)");
  });

  it("keeps the HTML forms understood by the ProseMirror schema", () => {
    const sanitized = sanitizePastedHTML(`
      <h2><strong>Heading</strong> <em>emphasis</em></h2>
      <blockquote><p>Quote</p></blockquote>
      <ul><li>one</li></ul><ol><li>two</li></ol>
      <pre><code>const answer = 42;</code></pre>
      <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>
      <hr><a href="example.com">site</a>
    `);

    expect(sanitized).toContain("<h2><strong>Heading</strong> <em>emphasis</em></h2>");
    expect(sanitized).toContain("<blockquote><p>Quote</p></blockquote>");
    expect(sanitized).toContain("<ul><li>one</li></ul><ol><li>two</li></ol>");
    expect(sanitized).toContain("<pre><code>const answer = 42;</code></pre>");
    expect(sanitized).toContain("<table><thead><tr><th>A</th></tr></thead>");
    expect(sanitized).toContain('<a href="https://example.com">site</a>');
  });

  it("unwraps unsupported elements while preserving their text and supported descendants", () => {
    expect(sanitizePastedHTML("<article>Before <mark><b>bold</b></mark> after</article>")).toBe(
      "Before <strong>bold</strong> after",
    );
  });

  it.each([
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ])("removes an unsafe link URI: %s", (href) => {
    expect(sanitizePastedHTML(`<a href="${href}">click</a>`)).toBe("<a>click</a>");
  });

  it("preserves external and data URI images with only safe image attributes", () => {
    expect(
      sanitizePastedHTML(
        '<img src="https://cdn.example/image.png" alt="Map" title="Realm" onerror="alert(1)" srcset="evil">' +
          '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Paste">',
      ),
    ).toBe(
      '<img src="https://cdn.example/image.png" alt="Map" title="Realm"><img src="data:image/png;base64,iVBORw0KGgo=" alt="Paste">',
    );
  });

  it("drops images with executable or non-image data sources", () => {
    expect(
      sanitizePastedHTML(
        '<img src="javascript:alert(1)" alt="bad"><img src="data:text/html,bad" alt="bad">',
      ),
    ).toBe("");
  });
});
