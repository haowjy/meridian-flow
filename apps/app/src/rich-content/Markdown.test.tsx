// @vitest-environment jsdom
/**
 * What the chat transcript makes of document links: a Markdown link to a
 * Context URI is a chip that follows, a relative path is text (chat has no
 * holder), an exact `@` reference keeps its identity, and `[[name]]` is text.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLinkRequester, createLinkResolution, type LinkTarget } from "@/core/editor/links";

import { Markdown } from "./Markdown";
import { TranscriptLinkNavigationContext } from "./TranscriptReference";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function links(): Array<{ text: string | null; role: string | null; title: string | null }> {
  return [...host.querySelectorAll("meridian-reference, [role='link'], span[title]")].map(
    (element) => ({
      text: element.textContent,
      role: element.getAttribute("role"),
      title: element.getAttribute("title"),
    }),
  );
}

describe("Markdown document links", () => {
  it("chips a Context URI link, leaves a relative one and [[name]] as text", async () => {
    const follow = vi.fn<(target: LinkTarget) => void>();
    const resolution = createLinkResolution();
    const source =
      "Meet [Lin Feng](kb://characters/Lin%20Feng.md), see [the cast](./cast.md), and [[Kael]].";
    await act(async () =>
      root.render(
        <TranscriptLinkNavigationContext.Provider
          value={{
            follow,
            canFollow: (target) => target.kind !== "relative",
            resolution,
            watch: createLinkRequester(resolution).watch,
          }}
        >
          <Markdown>{source}</Markdown>
        </TranscriptLinkNavigationContext.Provider>,
      ),
    );

    expect(host.textContent).toContain("[[Kael]]");
    expect(links()).toEqual([
      { text: "Lin Feng", role: "link", title: null },
      { text: "the cast", role: null, title: "./cast.md" },
    ]);
    const chip = [...host.querySelectorAll("[role='link']")][0] as HTMLElement;
    act(() => chip.click());
    expect(follow).toHaveBeenCalledWith({ kind: "scheme", uri: "kb://characters/Lin%20Feng.md" });
    resolution.destroy();
  });

  it("keeps an exact reference's identity on its [label](uri) occurrence", async () => {
    const text = "[Gate Map](uploads://@/Gate%20Map.png)";
    const source = `Compare ${text}.`;
    const from = source.indexOf(text);
    await act(async () =>
      root.render(
        <Markdown
          references={[
            {
              from,
              to: from + text.length,
              documentId: "doc-map",
              uri: "uploads://@/Gate Map.png",
            },
          ]}
        >
          {source}
        </Markdown>,
      ),
    );

    const reference = host.querySelector("[data-link-chip]");
    expect(reference?.textContent).toBe("Gate Map");
    expect(reference?.getAttribute("data-link-chip-icon")).toBe("uploads");
  });
});
