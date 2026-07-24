import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

describe("document markdown rendering", () => {
  it("renders registered containers and leaves without exposing MDX source", () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {[
          '<Layout align="center">',
          "  **Centered prose.**",
          "</Layout>",
          "",
          '<Figure src="https://example.com/map.png" alt="Realm map" caption="Known lands" />',
        ].join("\n")}
      </Markdown>,
    );

    expect(html).toContain("Centered prose.");
    expect(html).toContain("text-align:center");
    expect(html).toContain('src="https://example.com/map.png"');
    expect(html).toContain('alt="Realm map"');
    expect(html).toContain("Known lands");
    expect(html).not.toContain("&lt;Layout");
    expect(html).not.toContain("&lt;Figure");
  });

  it("strips unregistered MDX chrome while preserving readable children", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"<FuturePanel>\n  Still readable.\n</FuturePanel>"}</Markdown>,
    );

    expect(html).toContain("Still readable.");
    expect(html).not.toContain("FuturePanel");
    expect(html).not.toContain("&lt;");
  });
});
