import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { epubToMarkdown } from "./epub-markdown.js";
import { ConversionRefused } from "./limits.js";

/** Guards: an EPUB is read for its text, and a hostile one is refused before it inflates or resolves anything. */
const CONTAINER =
  '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfile full-path="c.opf"/></container>';
const OPF =
  '<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>';

function epub(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync({
    "META-INF/container.xml": strToU8(CONTAINER),
    "c.opf": strToU8(OPF),
    ...Object.fromEntries(
      Object.entries(files).map(([name, data]) => [
        name,
        typeof data === "string" ? strToU8(data) : data,
      ]),
    ),
  });
}

const refusal = (bytes: Uint8Array) =>
  epubToMarkdown(bytes).then(
    () => null,
    (error: unknown) => (error instanceof ConversionRefused ? error.reason : error),
  );

describe("epubToMarkdown", () => {
  it("follows the spine and keeps the chapter's text and headings", async () => {
    const markdown = await epubToMarkdown(
      epub({
        "a.xhtml":
          "<html><body><h1>One</h1><p>Hello <a href='x'>world</a></p><img src='i.png'/></body></html>",
      }),
    );
    expect(markdown).toBe("# T\n\n# One\n\nHello world");
  });

  it("refuses an entry whose declared size is over the cap, without inflating it", async () => {
    expect(
      await refusal(epub({ "a.xhtml": "<p>x</p>", "big.bin": new Uint8Array(65 * 1024 * 1024) })),
    ).toBe("hostile");
  });

  it("refuses too many entries", async () => {
    const files = Object.fromEntries(Array.from({ length: 5_001 }, (_, i) => [`f${i}`, "x"]));
    expect(await refusal(epub({ "a.xhtml": "<p>x</p>", ...files }))).toBe("hostile");
  });

  it("refuses a document that declares an entity", async () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE html [<!ENTITY e SYSTEM "file:///etc/passwd">]><html><body><p>&e;</p></body></html>';
    expect(await refusal(epub({ "a.xhtml": xxe }))).toBe("hostile");
  });
});
