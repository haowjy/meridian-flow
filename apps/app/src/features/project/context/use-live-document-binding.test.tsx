// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ controller: new AbortController() }));
vi.mock("./account-feature-context", () => ({
  useAccountEpochSignal: () => account.controller.signal,
}));

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectDocumentLiveOpener } from "./open-project-document";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";
import { type LiveDocumentHostBinding, useLiveDocumentBinding } from "./use-live-document-binding";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it("stays opening without an error when the account shuts down during bind", async () => {
  const reported: unknown[] = [];
  const previousReportError = globalThis.reportError;
  globalThis.reportError = (error) => reported.push(error);
  const opener = {
    open: async () => ({
      kind: "opened",
      admission: {
        bind: async () => {
          account.controller.abort();
          throw new Error("Account is closing");
        },
      },
    }),
  } as unknown as ProjectDocumentLiveOpener;
  let binding: LiveDocumentHostBinding | undefined;
  function Host() {
    binding = useLiveDocumentBinding({
      projectId: "project-1",
      documentId: "document-1",
      owner: "desktop-document-host",
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(
        <ProjectDocumentLiveOpenerContext.Provider value={opener}>
          <Host />
        </ProjectDocumentLiveOpenerContext.Provider>,
      );
    });
    expect(account.controller.signal.aborted).toBe(true);
    expect(binding?.state).toEqual({ kind: "opening", documentId: "document-1" });
    expect(reported).toEqual([]);
  } finally {
    act(() => root.unmount());
    globalThis.reportError = previousReportError;
  }
});
