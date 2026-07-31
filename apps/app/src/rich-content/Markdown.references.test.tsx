// @vitest-environment jsdom
/**
 * A reference surviving the whole markdown pipeline, which is where the
 * surprises are.
 *
 * The renderer sanitizes what it renders, and its sanitizer has never heard of
 * `manuscript://`: an href on that protocol is stripped, and `name` and `id`
 * come back wearing a `user-content-` prefix that would quietly turn every
 * target into a different string. These assertions are what keep the way around
 * both honest — our own element reaches the DOM carrying the target it was
 * given, a link that leaves the app is untouched, and a reference with nothing
 * behind it is quiet text rather than a control that does nothing.
 */
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createLinkResolution } from "@/core/links";
import { withReactRoot } from "@/test-support/react-dom-harness";

import { InternalReferenceProvider } from "./InternalReference";
import { Markdown } from "./Markdown";

const found: ResolvedDocumentLink = {
  documentId: "document-1",
  title: "The Third Gate",
  fileType: "markdown",
  scheme: "manuscript",
  path: "/chapters/the-third-gate.md",
  uri: "manuscript://chapters/the-third-gate.md",
  workId: null,
};

function transcript(text: string, answer: ResolvedDocumentLink | null, open = vi.fn()) {
  const resolution = createLinkResolution();
  resolution.registerResolver(async () => answer);
  return {
    open,
    node: (
      <InternalReferenceProvider runtime={{ resolution, open }}>
        <Markdown>{text}</Markdown>
      </InternalReferenceProvider>
    ),
  };
}

/** Lets the resolver's answer land and React redraw on it. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const reference = () => document.querySelector(".meridian-reference");

describe("a reference in a sent message", () => {
  it("renders a wikilink as a door once the project answers", async () => {
    const { node, open } = transcript("Rewrite [[The Third Gate]] please", found);
    await withReactRoot(node, async () => {
      await settle();
      const element = reference();

      expect(element?.tagName).toBe("BUTTON");
      expect(element?.textContent).toBe("The Third Gate");
      expect(element?.getAttribute("data-link-state")).toBe("resolved");

      await act(async () => {
        (element as HTMLButtonElement).click();
      });
      expect(open).toHaveBeenCalledWith("document-1");
    });
  });

  it("renders a scheme URI as a door too, spelled the way it was sent", async () => {
    const { node } = transcript("Look at manuscript://chapters/a.md", found);
    await withReactRoot(node, async () => {
      await settle();

      expect(reference()?.textContent).toBe("manuscript://chapters/a.md");
      expect(reference()?.tagName).toBe("BUTTON");
    });
  });

  it("renders a picture reference as the composer's pill, never the raw URI", async () => {
    const picture: ResolvedDocumentLink = {
      documentId: "asset-1",
      title: "pic-1",
      fileType: "image",
      scheme: "manuscript",
      path: "pictures/pic-1.png",
      uri: "manuscript://pictures/pic-1.png",
      workId: null,
    };
    const { node, open } = transcript("Look at manuscript://pictures/pic-1.png", picture);
    await withReactRoot(node, async () => {
      await settle();
      const element = reference();

      // Icon + filename (extension and all — `title` is the stripped name).
      expect(element?.tagName).toBe("BUTTON");
      expect(element?.getAttribute("data-link-file")).toBe("image");
      expect(element?.querySelector("svg")).not.toBeNull();
      expect(element?.textContent).toBe("pic-1.png");
      expect(element?.textContent).not.toContain("manuscript://");

      // Still a door: it opens the picture document like any reference.
      await act(async () => {
        (element as HTMLButtonElement).click();
      });
      expect(open).toHaveBeenCalledWith("asset-1");
    });
  });

  it("goes quiet rather than dead when nothing is behind it yet", async () => {
    const { node } = transcript("Rewrite [[Chapter 400]] please", null);
    await withReactRoot(node, async () => {
      await settle();

      // Not a control: the transcript never offers to create the page.
      expect(reference()?.tagName).toBe("SPAN");
      expect(reference()?.getAttribute("data-link-state")).toBe("unresolved");
    });
  });

  it("is the writer's own words where nothing can resolve them", async () => {
    await withReactRoot(
      <InternalReferenceProvider runtime={null}>
        <Markdown>Rewrite [[The Third Gate]] please</Markdown>
      </InternalReferenceProvider>,
      async () => {
        await settle();

        expect(reference()).toBeNull();
        expect(document.body.textContent).toContain("Rewrite The Third Gate please");
      },
    );
  });

  it("leaves a link that leaves the app exactly as the renderer had it", async () => {
    const { node } = transcript("See [the docs](https://example.com/a)", found);
    await withReactRoot(node, async () => {
      await settle();

      // Whatever the renderer draws an external link as — today a control that
      // asks before it opens a new tab — is untouched by any of this.
      expect(document.querySelector('[data-streamdown="link"]')?.textContent).toBe("the docs");
      expect(reference()).toBeNull();
    });
  });
});
