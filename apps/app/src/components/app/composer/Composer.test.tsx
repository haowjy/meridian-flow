// @vitest-environment jsdom
/** Rendered Composer send/stop behavior while an agent run is live. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerSubmitEnvelope, type ComposerSubmitOutcome } from "./Composer";
import type { ComposerChatCommand } from "./command";
import {
  type ComposerReferenceAttrs,
  composerReferenceContent,
  plainComposerDoc,
  serializeComposerDraft,
} from "./composer-document";

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
  props: {
    running?: boolean;
    initialDraft?: ReturnType<typeof draft>;
    onStop?: () => void;
    commands?: readonly ComposerChatCommand[];
  } = {},
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
        running={props.running}
        initialDraft={props.initialDraft}
        onStop={props.onStop}
        onSubmit={onSubmit}
        commands={props.commands}
      />,
    );
  });
  return onSubmit;
}

const editorElement = () => host.querySelector<HTMLElement>(".composer-input");

async function pressEnter() {
  await act(async () => {
    editorElement()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pressEscape() {
  await act(async () => {
    editorElement()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
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
    const onSubmit = await render({ running: true, initialDraft: draft("Follow up") });
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

  it("stops on Escape when the composer is empty, like the Stop button", async () => {
    const onStop = vi.fn();
    await render({ running: true, onStop });
    expect(button()?.getAttribute("aria-label")).toBe("Stop");
    await pressEscape();
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("leaves the run and the draft alone on Escape while drafting", async () => {
    const onStop = vi.fn();
    await render({ running: true, initialDraft: draft("Follow up"), onStop });
    await pressEscape();
    expect(onStop).not.toHaveBeenCalled();
    expect(editorElement()?.textContent).toBe("Follow up");
    expect(button()?.getAttribute("aria-label")).toBe("Send message");
  });

  it("does not stop on Escape when no run is active", async () => {
    const onStop = vi.fn();
    await render({ onStop });
    await pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("Composer chat verbs", () => {
  const compact = () => {
    const run = vi.fn();
    return {
      run,
      commands: [{ slug: "compact", name: "Compact conversation", description: "d", run }] as const,
    };
  };

  it("sends `/compact <instructions>` as the command, never as a message", async () => {
    const { run, commands } = compact();
    const onSubmit = await render({
      running: true,
      initialDraft: draft("/compact   Keep the sect names  "),
      commands,
    });
    await pressEnter();
    expect(run).toHaveBeenCalledWith("Keep the sect names");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editorElement()?.textContent).toBe("");
  });

  it("sends a bare `/compact` with no instructions", async () => {
    const { run, commands } = compact();
    await render({ initialDraft: draft("/compact"), commands });
    await pressEnter();
    expect(run).toHaveBeenCalledWith(null);
  });

  it("sends `/compact` text as a message on a surface that registers no verbs", async () => {
    const onSubmit = await render({ initialDraft: draft("/compact Keep the names") });
    await pressEnter();
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe("Composer references", () => {
  it("draws a reference atom as a link chip in its URI's family", async () => {
    // Branded ids and URIs: the fixture states them as plain strings.
    const reference = {
      documentId: "01900000-0000-7000-8000-000000000001",
      uri: "kb://characters/Kael.md",
      fileType: "markdown",
      authority: { kind: "project", projectId: "01900000-0000-7000-8000-000000000002" },
      label: "Kael",
      imageCapable: false,
      upload: null,
    } as unknown as ComposerReferenceAttrs;
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Ask " }, composerReferenceContent(reference)],
        },
      ],
    };
    await render({ initialDraft: { ...serializeComposerDraft(doc).draft } });

    await vi.waitFor(() => {
      const atom = host.querySelector("[data-composer-reference]");
      expect(atom?.getAttribute("data-link-chip")).toBe("filled");
      expect(atom?.getAttribute("data-link-chip-icon")).toBe("kb");
      expect(atom?.textContent).toBe("Kael");
    });
  });
});
