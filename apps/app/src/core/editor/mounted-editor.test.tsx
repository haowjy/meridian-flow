// @vitest-environment jsdom
/** Direct enforcement of the mount-only collaborative editor lifetime. */

import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createAgentNameStore } from "./agent-name-store";
import type { DocumentSession } from "./document-session";
import { createLocalPresence } from "./local-presence";
import {
  type EditorMountIdentity,
  type MountedEditorInput,
  useMountedEditor,
} from "./mounted-editor";
import { SessionMarkerStore } from "./session-marker-store";

const identity: EditorMountIdentity = {
  surface: "live",
  documentId: "document-1",
  projectId: "project-1",
  schemaType: "document",
  collaborationDecorations: false,
  detached: true,
};
const agentNames = createAgentNameStore();

function session(documentId: string): DocumentSession {
  const document = new Y.Doc({ gc: false });
  const awareness = new Awareness(document);
  return {
    roomKey: documentId,
    document,
    awareness,
    presence: createLocalPresence(awareness),
    markerStore: new SessionMarkerStore("writer"),
    reportSchemaRepair: () => {},
  } as unknown as DocumentSession;
}

let rerender: (next: Partial<MountedEditorInput>) => void = () => {};
let mounted: Editor | null = null;

function Harness({ initial }: { initial: MountedEditorInput }) {
  const [input, setInput] = useState(initial);
  rerender = (next) => setInput((previous) => ({ ...previous, ...next }));
  mounted = useMountedEditor(input);
  return null;
}

describe("useMountedEditor", () => {
  it.each([
    ["session", (_input: MountedEditorInput) => ({ session: session("document-1") })],
    ["evidence", (input: MountedEditorInput) => ({ evidenceDegraded: !input.evidenceDegraded })],
  ] as const)("does not reconstruct for a changed %s input", async (_name, changedInput) => {
    const initial: MountedEditorInput = {
      identity,
      session: session("document-1"),
      agentNames,
      placeholder: "Start writing",
      surface: { editable: true, editorProps: {} },
      evidenceDegraded: false,
    };

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => {
        root.render(<Harness initial={initial} />);
      });
      const original = mounted;
      expect(original).not.toBeNull();

      await act(async () => {
        rerender(changedInput(initial));
      });

      expect(mounted).toBe(original);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});
