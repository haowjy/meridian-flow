// @vitest-environment jsdom
/** Rendered Editor recovery distinguishes loading, error, and authoritative empty catalogs. */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { EditorWorkRecovery } from "./EditorWorkRecovery";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

describe("EditorWorkRecovery", () => {
  it("renders loading only for unresolved scope", async () => {
    await withReactRoot(
      <EditorWorkRecovery
        scope={{ status: "loading", workId: "" }}
        onRetry={vi.fn()}
        onOpenWork={vi.fn()}
      />,
      async () => expect(document.body.textContent).toContain("Loading Work…"),
    );
  });

  it("renders retry for a failed catalog", async () => {
    const retry = vi.fn();
    await withReactRoot(
      <EditorWorkRecovery
        scope={{ status: "error", workId: "" }}
        onRetry={retry}
        onOpenWork={vi.fn()}
      />,
      async () => {
        await act(async () => document.querySelector<HTMLButtonElement>("button")?.click());
        expect(retry).toHaveBeenCalledOnce();
      },
    );
  });

  it("renders a Work action instead of loading for an empty catalog", async () => {
    const openWork = vi.fn();
    await withReactRoot(
      <EditorWorkRecovery scope={{ status: "empty" }} onRetry={vi.fn()} onOpenWork={openWork} />,
      async () => {
        expect(document.body.textContent).toContain("No Work yet.");
        expect(document.body.textContent).not.toContain("Loading Work");
        await act(async () => document.querySelector<HTMLButtonElement>("button")?.click());
        expect(openWork).toHaveBeenCalledOnce();
      },
    );
  });
});
