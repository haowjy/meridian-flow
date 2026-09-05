// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { Markdown } from "./Markdown";

describe("transcript references", () => {
  it("activates only an exact stable-id and URI resolution", async () => {
    const open = vi.fn();
    const documentId = "33333333-3333-4333-8333-333333333333";
    await withReactRoot(
      <Markdown
        references={[{ from: 0, to: 12, documentId, uri: "uploads://@/gate-map.png" }]}
        referenceResolutions={
          new Map([
            [
              documentId,
              { documentId, uri: "uploads://@/gate-map.png", label: "Gate Map", available: true },
            ],
          ])
        }
        onOpenReference={open}
      >
        [[Gate Map]]
      </Markdown>,
      () => {
        const button = document.querySelector("button");
        expect(button?.textContent).toBe("[[Gate Map]]");
        button?.click();
        expect(open).toHaveBeenCalledWith(documentId);
      },
    );
  });
  it("renders a URI mismatch quietly as text", async () => {
    const documentId = "33333333-3333-4333-8333-333333333333";
    await withReactRoot(
      <Markdown
        references={[{ from: 0, to: 12, documentId, uri: "uploads://@/old.png" }]}
        referenceResolutions={
          new Map([
            [documentId, { documentId, uri: "uploads://@/new.png", label: "New", available: true }],
          ])
        }
      >
        [[Gate Map]]
      </Markdown>,
      () => {
        expect(document.querySelector("button")).toBeNull();
        expect(document.body.textContent).toContain("[[Gate Map]]");
      },
    );
  });
});
