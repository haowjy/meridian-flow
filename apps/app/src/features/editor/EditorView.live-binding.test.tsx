// @vitest-environment jsdom
/** Ordinary live editors consume the exact session supplied by their host. */
import { describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";

const registry = vi.hoisted(() => ({
  retain: vi.fn(),
  release: vi.fn(),
  get: vi.fn(),
  getRoom: vi.fn(),
  getDetached: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
  msg: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => children,
}));

vi.mock("@/features/project/context/account-feature-context", () => ({
  useLiveDocumentSessionRegistry: () => registry,
}));
vi.mock("./editor-bind-horizon", () => ({
  waitForEditorBindHorizon: () => new Promise(() => undefined),
}));

import { EditorView } from "./EditorView";

describe("EditorView live binding", () => {
  it("never retains or looks up by id when its host supplies the session", async () => {
    const session = {
      getSnapshot: () => ({ status: "connecting", schemaRepairs: [] }),
      subscribe: () => () => undefined,
      whenLocalPersistenceSynced: async () => undefined,
      whenSynced: async () => undefined,
    } as unknown as DocumentSession;

    await withReactRoot(
      <EditorView projectId="project-a" documentId="document-a" session={session} />,
    );

    expect(registry.retain).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
    expect(registry.getRoom).not.toHaveBeenCalled();
    expect(registry.getDetached).not.toHaveBeenCalled();
  });
});
