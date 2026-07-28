// @vitest-environment jsdom
/** Writer-copy contract for the minimal schema-fence notice. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { SchemaFenceNotice } = await import("./SchemaFenceNotice");

describe("SchemaFenceNotice", () => {
  it("renders the superseded-client copy without surface styling", () => {
    const html = renderToStaticMarkup(
      <SchemaFenceNotice fence={{ reason: "client-superseded" }} />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(html).toContain("data-schema-fence");
    expect(html).toContain('data-schema-fence-reason="client-superseded"');
    expect(container.textContent).toBe(
      "This chapter was opened in a newer version of Meridian. Refresh to keep writing.",
    );
    expect(html).not.toContain("class=");
  });
});
