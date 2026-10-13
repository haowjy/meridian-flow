// @vitest-environment jsdom
/** A warm Work or item change must never be overwritten by the departing review. */
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { exitedReviewOwnsAddress, ReviewAddressOwner } from "../ReviewAddressOwner";
import { EditorReviewHandoffProvider } from "./editor-review-handoff";

it.each(["work", "item"])("a same-locator %s switch keeps the new request", async (change) => {
  let switchRequest!: () => void;
  const write = vi.fn();
  const exit = vi.fn();
  function Harness() {
    const [next, setNext] = useState(false);
    switchRequest = () => setNext(true);
    const review = {
      controller: {
        workId: "a",
        inlineReview: { documentId: "document", itemKey: "item-a" },
        exitInlineReview: exit,
      },
      files: [],
      fileForDocument: () => undefined,
    } as unknown as DraftReviewContextValue;
    const address = {
      workId: next && change === "work" ? "b" : "a",
      itemKey: next && change === "item" ? "item-b" : "item-a",
    };
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async () => ({ kind: "applied" })}
      >
        <ReviewAddressOwner
          admission="pending"
          review={review}
          presented={{
            container: "editor",
            documentId: change === "work" ? "document" : null,
            scheme: "kb",
            path: "/Same",
            review: address,
            draftOnly: false,
          }}
          port={{ write, admit: vi.fn() }}
        />
        <output>
          {address.workId}:{address.itemKey}
        </output>
      </EditorReviewHandoffProvider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    expect(exit).not.toHaveBeenCalled();
    await act(async () => switchRequest());
    expect(exit).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(document.querySelector("output")?.textContent).toBe(
      change === "work" ? "b:item-a" : "a:item-b",
    );
  });
});

const owned = {
  container: "editor" as const,
  workId: "a",
  itemKey: "item-a",
  documentId: "document",
  locator: { scheme: "kb" as const, path: "/Confirmed" },
};
it("Exit before identity settles consumes only the confirmed owned locator", () => {
  expect(exitedReviewOwnsAddress(owned, { ...owned, documentId: null })).toBe(true);
  expect(
    exitedReviewOwnsAddress(owned, {
      ...owned,
      documentId: null,
      locator: { scheme: "kb", path: "/Guess" },
    }),
  ).toBe(false);
  expect(exitedReviewOwnsAddress(owned, { ...owned, documentId: "other" })).toBe(false);
  expect(
    exitedReviewOwnsAddress(owned, { ...owned, locator: { scheme: "user", path: "/Moved" } }),
  ).toBe(true);
});
it("Editor and Dock never consume one another's Exit", () => {
  expect(exitedReviewOwnsAddress(owned, { ...owned, container: "dock" })).toBe(false);
});

it("Exit during unresolved identity clears only the owner's confirmed request", async () => {
  let leave!: () => void;
  const write = vi.fn();
  function Harness() {
    const [exited, setExited] = useState(false);
    leave = () => setExited(true);
    const review = {
      controller: {
        workId: "a",
        inlineReview: exited ? null : { documentId: "document", itemKey: "item-a" },
        exitInlineReview: vi.fn(),
      },
      files: [],
      fileForDocument: () => ({ contextLocation: { scheme: "kb", path: "/Confirmed" } }),
    } as unknown as DraftReviewContextValue;
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async () => ({ kind: "applied" })}
      >
        <ReviewAddressOwner
          admission={exited ? "pending" : "admitted"}
          review={review}
          presented={{
            container: "editor",
            documentId: exited ? null : "document",
            scheme: "kb",
            path: "/Confirmed",
            review: { workId: "a", itemKey: "item-a" },
            draftOnly: false,
          }}
          port={{ write, admit: vi.fn() }}
        />
      </EditorReviewHandoffProvider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    expect(write).not.toHaveBeenCalled();
    await act(async () => leave());
    expect(write).toHaveBeenCalledExactlyOnceWith(null);
  });
});
