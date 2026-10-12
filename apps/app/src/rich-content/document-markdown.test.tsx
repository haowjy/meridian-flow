/** Canonical structure and incomplete Markdown at the settled rendering boundary. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const render = (source: string, breaks = false) =>
  renderToStaticMarkup(<Markdown breaks={breaks}>{source}</Markdown>);

describe("settled document rendering", () => {
  it("renders canonical blocks and marks without vendor chrome", () => {
    const html = render(
      "# Gate\n\n**bold** *em* ~~gone~~ `inline` [link](https://example.com) ![gate](https://example.com/gate.png)  \nnext\n\n> quote\n\n3. first\n   - nested\n4. second\n\n| A | B |\n| :- | -: |\n| one | two |\n\n---",
    );
    for (const tag of [
      "h1",
      "strong",
      "em",
      "s",
      "code",
      "a",
      "img",
      "br",
      "blockquote",
      "ol",
      "ul",
      "li",
      "table",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
    ]) {
      expect(html).toContain(`<${tag}`);
    }
    expect(html).toContain('start="3"');
    expect(html).toContain("text-align:right");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('data-link-kind="external"');
    expect(render("[chapter](manuscript://chapter.md)")).toContain('data-link-chip="filled"');
    expect(render("[chapter](manuscript://chapter.md)")).toContain(
      'data-link-chip-icon="manuscript"',
    );
    expect(
      render("[**chapter** one](manuscript://chapter.md)").match(/data-link-chip=/g),
    ).toHaveLength(1);
    expect(render("[**web** link](https://example.com)").match(/data-link-kind=/g)).toHaveLength(1);
  });

  it("highlights fences with editor token classes and only a copy action", () => {
    const html = render("```ts\nconst answer = 42;\n```");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-number");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).not.toContain("code-block-header");
    expect(html).not.toContain("download");
  });

  it("retains incomplete syntax without inventing links or tables", () => {
    expect(render("**bol")).toContain("**bol");
    expect(render("[half](https://exam")).not.toContain("<a");
    expect(render("| A | B |")).not.toContain("<table");
    expect(render("```unknown\n<unfinished>")).toContain("&lt;unfinished&gt;");
    expect(render("- first\n  - inner\n- next").match(/<ul>/g)).toHaveLength(2);
    expect(render("first\nsecond", true)).toContain("first<br/>second");
    expect(render("[unsafe](javascript:alert%281%29)")).not.toContain('href="javascript:');
  });
});

it("uses the Editor picture-source boundary at the chat image sink", () => {
  for (const source of [
    "javascript:alert%281%29",
    "data:text/html;base64,AAAA",
    "/map.png",
    "asset:abc",
  ]) {
    expect(render(`![unavailable](${source})`)).not.toContain("<img");
    expect(render(`![unavailable](${source})`)).toContain("unavailable");
  }
  for (const source of [
    "https://example.com/a.png",
    "http://example.com/a.png",
    "//example.com/a.png",
    "data:image/png;base64,AAAA",
  ]) {
    expect(render(`![picture](${source})`)).toContain(`<img src="${source}"`);
  }
});
