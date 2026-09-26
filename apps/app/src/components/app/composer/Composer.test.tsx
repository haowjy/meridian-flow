// @vitest-environment jsdom
/** Rendered Composer send/stop behavior while an agent run is live. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerSubmitEnvelope, type ComposerSubmitOutcome } from "./Composer";
import { plainComposerDoc, serializeComposerDraft } from "./composer-document";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const message = strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
    return { id: message, message };
  },
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (descriptor: { message: string }) => descriptor.message } }),
}));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
let root: Root;
let host: HTMLDivElement;

function draft(text: string) {
  const snapshot = serializeComposerDraft(plainComposerDoc(text)).draft;
  return {
    ...snapshot,
    selection: { anchor: 1 + text.length, head: 1 + text.length },
  };
}

async function render(
  props: { streaming?: boolean; initialDraft?: ReturnType<typeof draft> } = {},
) {
  const onSubmit = vi.fn(
    (envelope: ComposerSubmitEnvelope): ComposerSubmitOutcome => ({
      kind: "accepted",
      submissionId: envelope.submissionId,
      acceptedRevision: envelope.acceptedRevision,
    }),
  );
  await act(() => {
    root.render(
      <Composer
        streaming={props.streaming}
        initialDraft={props.initialDraft}
        onSubmit={onSubmit}
      />,
    );
  });
  return onSubmit;
}

const button = () => host.querySelector<HTMLButtonElement>("[data-composer] button:last-of-type");

beforeEach(() => {
  previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("Composer during a live run", () => {
  it("turns Stop into Send while drafting, sends on Enter, then returns to Stop", async () => {
    const onSubmit = await render({ streaming: true, initialDraft: draft("Follow up") });
    expect(button()?.getAttribute("aria-label")).toBe("Send message");
    const editor = host.querySelector<HTMLElement>(".composer-input");
    await act(async () => {
      editor?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(button()?.getAttribute("aria-label")).toBe("Stop");
  });
});
