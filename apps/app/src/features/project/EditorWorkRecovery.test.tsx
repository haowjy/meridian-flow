// @vitest-environment jsdom
/** Rendered Editor recovery distinguishes loading, error, and unavailable selections. */
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
      <EditorWorkRecovery scope={{ status: "loading", workId: "" }} onRetry={vi.fn()} />,
      async () => expect(document.body.textContent).toContain("Loading Work…"),
    );
  });

  it("renders retry for a failed catalog", async () => {
    const retry = vi.fn();
    await withReactRoot(
      <EditorWorkRecovery scope={{ status: "error", workId: "" }} onRetry={retry} />,
      async () => {
        await act(async () => document.querySelector<HTMLButtonElement>("button")?.click());
        expect(retry).toHaveBeenCalledOnce();
      },
    );
  });

  it("renders retry for an unavailable explicit selection", async () => {
    const retry = vi.fn();
    await withReactRoot(
      <EditorWorkRecovery scope={{ status: "unavailable", workId: "missing" }} onRetry={retry} />,
      async () => {
        expect(document.body.textContent).toContain("This Work is unavailable.");
        expect(document.body.textContent).not.toContain("Loading Work");
        await act(async () => document.querySelector<HTMLButtonElement>("button")?.click());
        expect(retry).toHaveBeenCalledOnce();
      },
    );
  });
});
