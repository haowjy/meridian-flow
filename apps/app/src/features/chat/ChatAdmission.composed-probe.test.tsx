// @vitest-environment jsdom
/** Direct production composition probe: real Composer + controller + thread store. */
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
import {
  Composer,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
} from "@/components/app/composer";

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@/components/app/composer/placeholders", () => ({
  useComposerPlaceholder: () => "Write",
}));
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
});
const upload = {
  intakeId: "intake-1",
  documentId: "01900000-0000-7000-8000-000000000001",
  uri: "uploads://@/map.png" as const,
  locationRevision: "r1",
};
const snapshot = {
  revision: 7,
  doc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Use " },
          {
            type: "composerReference",
            attrs: {
              reference: {
                documentId: upload.documentId,
                uri: upload.uri,
                fileType: "image",
                authority: { kind: "none", projectId: "project-1" },
                label: "map.png",
                spelling: "[[map.png]]",
                imageCapable: true,
                upload,
              },
            },
          },
        ],
      },
    ],
  },
  selection: { anchor: 7, head: 3 },
  ownedUploads: [upload],
};
async function probe(scenario: ThreadRunScenario) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const ref = createRef<ComposerHandle>();
  const onSubmit = async (envelope: ComposerSubmitEnvelope) => {
    const optimistic = scenario.store.getState().appendUserTurn("thread_1", envelope.text);
    return scenario.controller.submit("thread_1", envelope, {
      optimisticUserTurnId: optimistic.id,
    });
  };
  await act(async () => root.render(<Composer ref={ref} onSubmit={onSubmit} />));
  await act(async () => {
    ref.current?.restoreSnapshot(snapshot);
  });
  const before = ref.current?.snapshot();
  const sending = act(async () => {
    (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click();
  });
  return { ref, before, sending };
}
describe("Chat admission composed probe", () => {
  it("connection-token failure preserves exact JSON, selection, tokens, and performs zero POST", async () => {
    const scenario = new ThreadRunScenario();
    scenario.disconnectAdmission();
    const { ref, before, sending } = await probe(scenario);
    scenario.rejectConnection(new Error("connection unavailable"));
    await sending;
    expect(ref.current?.snapshot()).toMatchObject({
      doc: before?.doc,
      selection: before?.selection,
      ownedUploads: before?.ownedUploads,
    });
    expect(scenario.appendRequests).toHaveLength(0);
    expect(scenario.turns()).toEqual([]);
  });
  it("authoritative stale-token failure preserves exact draft and performs one POST", async () => {
    const scenario = new ThreadRunScenario({
      append: async () =>
        Promise.reject(
          new HttpResponseError("connection_token_not_live", 409, {
            message: "connection_token_not_live",
          }),
        ),
    });
    const { ref, before, sending } = await probe(scenario);
    await sending;
    expect(ref.current?.snapshot()).toMatchObject({
      doc: before?.doc,
      selection: before?.selection,
      ownedUploads: before?.ownedUploads,
    });
    expect(scenario.appendRequests).toHaveLength(1);
    expect(scenario.turns()).toEqual([]);
  });
});
