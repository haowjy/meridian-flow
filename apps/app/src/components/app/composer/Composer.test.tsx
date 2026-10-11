// @vitest-environment jsdom
/** Rendered Composer send/stop behavior while an agent run is live. */
import { type CatalogCacheView, emptyCatalogView } from "@meridian/resource-replica";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Composer,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
  type ComposerSubmitOutcome,
} from "./Composer";
import type { ComposerChatCommand } from "./command";
import { plainComposerDoc, serializeComposerDraft } from "./composer-document";

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
  it("leaves the run and the draft alone on Escape while drafting", async () => {
    const onStop = vi.fn();
    await render({ running: true, initialDraft: draft("Follow up"), onStop });
    await pressEscape();
    expect(onStop).not.toHaveBeenCalled();
    expect(editorElement()?.textContent).toBe("Follow up");
    expect(button()?.getAttribute("aria-label")).toBe("Send message");
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

  it("sends `/compact` text as a message on a surface that registers no verbs", async () => {
    const onSubmit = await render({ initialDraft: draft("/compact Keep the names") });
    await pressEnter();
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

it("clears accepted presentation without publishing an empty draft over another pane's writing", async () => {
  let persistedWords = "New writing in another pane";
  await act(() =>
    root.render(
      <Composer
        initialDraft={draft("Submitted words")}
        onDraftChange={(change) => {
          persistedWords = change.text;
        }}
        onSubmit={(envelope) => ({
          kind: "accepted",
          submissionId: envelope.submissionId,
          acceptedRevision: envelope.acceptedRevision,
        })}
      />,
    ),
  );
  await pressEnter();
  expect(editorElement()?.textContent).toBe("");
  expect(persistedWords).toBe("New writing in another pane");
});

it("leaves rejected words visible without owning the lifecycle transfer", async () => {
  const onDraftChange = vi.fn();
  await act(() =>
    root.render(
      <Composer
        initialDraft={draft("Keep these words")}
        onDraftChange={onDraftChange}
        onSubmit={(envelope) => ({
          kind: "rejected",
          submissionId: envelope.submissionId,
          acceptedRevision: envelope.acceptedRevision,
        })}
      />,
    ),
  );
  await pressEnter();
  expect(editorElement()?.textContent).toBe("Keep these words");
  expect(onDraftChange).not.toHaveBeenCalled();
});

it("does not prepend a rejected submission to the live draft edited during admission", async () => {
  const ref = createRef<ComposerHandle>();
  let reject: ((outcome: ComposerSubmitOutcome) => void) | undefined;
  let sent: ComposerSubmitEnvelope | undefined;
  await act(() =>
    root.render(
      <Composer
        ref={ref}
        initialDraft={draft("Original")}
        onSubmit={(envelope) => {
          sent = envelope;
          return new Promise((resolve) => {
            reject = resolve;
          });
        }}
      />,
    ),
  );
  await pressEnter();
  await act(() => {
    ref.current?.restoreSnapshot(draft("Original continued"));
  });
  await act(async () => {
    if (!sent || !reject) throw new Error("Send was not dispatched");
    reject({
      kind: "rejected",
      submissionId: sent.submissionId,
      acceptedRevision: sent.acceptedRevision,
    });
  });
  expect(editorElement()?.textContent).toBe("Original continued");
});

it("drops a restored missing reference only after successful catalog acquisition, keeping prose", async () => {
  const accountId = "01900000-0000-7000-8000-000000000002";
  const doc = plainComposerDoc("Keep the scene ");
  doc.content?.[0]?.content?.push({
    type: "composerReference",
    attrs: {
      reference: {
        documentId: "01900000-0000-7000-8000-000000000001",
        uri: "manuscript://removed.md",
        authority: { kind: "project", projectId: accountId },
        fileType: "markdown",
        label: "removed.md",
        imageCapable: false,
        upload: null,
      },
    },
  });
  let acquire: ((view: CatalogCacheView) => void) | undefined;
  const onDraftChange = vi.fn();
  await act(() =>
    root.render(
      <Composer
        initialDraft={serializeComposerDraft(doc).draft}
        onSubmit={(envelope) => ({
          kind: "accepted",
          submissionId: envelope.submissionId,
          acceptedRevision: envelope.acceptedRevision,
        })}
        onDraftChange={onDraftChange}
        referenceCatalog={{
          label: "References",
          openContext: () => ({ warmScopes: [] }),
          port: {
            status: () => "loading",
            read: () => null,
            subscribe: () => () => {},
            acquire: () =>
              new Promise((resolve) => {
                acquire = resolve;
              }),
          },
        }}
      />,
    ),
  );
  expect(host.querySelector("[data-composer-reference]")?.textContent).toBe("removed.md");
  await act(async () => {
    if (!acquire) throw new Error("Catalog was not acquired");
    acquire(emptyCatalogView({ kind: "project", projectId: accountId }));
  });
  expect(host.querySelector("[data-composer-reference]")).toBeNull();
  expect(editorElement()?.textContent).toBe("Keep the scene ");
  expect(onDraftChange.mock.calls.at(-1)?.[0].text).toBe("Keep the scene ");
});
