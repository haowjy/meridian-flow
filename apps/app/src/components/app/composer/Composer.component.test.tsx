// @vitest-environment jsdom
/** Real TipTap settlement and upload-ownership behavior. */
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({ t: (value: TemplateStringsArray) => value.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./placeholders", () => ({ useComposerPlaceholder: () => "Write" }));

import {
  Composer,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
  type ComposerSubmitOutcome,
  type ComposerUploadPort,
} from "./Composer";

let root: Root;
let host: HTMLDivElement;
async function mount(
  onSubmit: (
    value: ComposerSubmitEnvelope,
  ) => ComposerSubmitOutcome | Promise<ComposerSubmitOutcome>,
  extra: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const ref = createRef<ComposerHandle>();
  await act(async () => root.render(<Composer ref={ref} onSubmit={onSubmit} {...extra} />));
  return ref;
}
async function send() {
  await act(async () =>
    (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click(),
  );
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
});
const outcome = (
  envelope: ComposerSubmitEnvelope,
  kind: ComposerSubmitOutcome["kind"],
): ComposerSubmitOutcome => ({
  kind,
  submissionId: envelope.submissionId,
  acceptedRevision: envelope.acceptedRevision,
});
const textSnapshot = (text: string, revision: number) => ({
  revision,
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
  },
  selection: { anchor: text.length + 1, head: text.length + 1 },
  ownedUploads: [],
});
describe("Composer draft changes", () => {
  it("emits one authoritative snapshot with atomic JSON, selection, and owned uploads", async () => {
    const onDraftChange = vi.fn();
    const ref = await mount((e) => outcome(e, "accepted"), { onDraftChange });
    const upload = {
      intakeId: "intake-change",
      documentId: "01900000-0000-7000-8000-000000000007",
      uri: "uploads://@/change.png" as const,
      locationRevision: "revision-7",
    };
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "composerReference",
              attrs: {
                reference: {
                  documentId: upload.documentId,
                  uri: upload.uri,
                  fileType: "image",
                  authority: { kind: "none", projectId: "project-1" },
                  label: "change",
                  spelling: "[[change]]",
                  imageCapable: true,
                  upload,
                },
              },
            },
          ],
        },
      ],
    };
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 4,
        doc,
        selection: { anchor: 1, head: 2 },
        ownedUploads: [upload],
      }),
    );
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const change = onDraftChange.mock.calls[0]?.[0];
    expect(host.querySelector("[data-composer-reference]")?.textContent).toBe("change");
    expect(change.text).toBe("[[change]]");
    expect(change.snapshot.doc).toEqual(doc);
    expect(change.snapshot.selection).toEqual({ anchor: 1, head: 2 });
    expect(change.snapshot.ownedUploads).toEqual([upload]);
    expect(change.snapshot.revision).toBe(ref.current?.snapshot().revision);
  });
});

describe("Composer settlement", () => {
  it("preserves a newer revision against an older accepted result", async () => {
    let settle!: (value: ComposerSubmitOutcome) => void;
    let frozen!: ComposerSubmitEnvelope;
    const ref = await mount((e) => {
      frozen = e;
      return new Promise((r) => {
        settle = r;
      });
    });
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("first", 1)));
    await send();
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("newer", 2)));
    await act(async () => settle(outcome(frozen, "accepted")));
    expect(ref.current?.getDraft()).toBe("newer");
  });
  it("restores the exact snapshot and backward selection on definite rejection", async () => {
    let frozen!: ComposerSubmitEnvelope;
    const ref = await mount((e) => {
      frozen = e;
      return outcome(e, "rejected");
    });
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 4,
        doc: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "abcdef" }] }],
        },
        selection: { anchor: 5, head: 3 },
        ownedUploads: [],
      }),
    );
    await send();
    expect(ref.current?.snapshot().doc).toEqual(frozen.draft.doc);
    expect(ref.current?.snapshot().selection).toEqual({ anchor: 5, head: 3 });
  });
  it("leaves an ambiguous draft visible and locked", async () => {
    const ref = await mount((e) => outcome(e, "ambiguous"));
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("uncertain", 1)));
    await send();
    expect(ref.current?.getDraft()).toBe("uncertain");
    expect(
      (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
describe("Composer upload deletion", () => {
  it("retains an upload when its draft reference is removed or accepted", async () => {
    const deleteDraft = vi.fn(async () => {});
    const port = { intake: vi.fn(), deleteDraft };
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: port,
      uploadScope: { kind: "none", projectId: "p" },
    });
    const upload = {
      intakeId: "i",
      documentId: "01900000-0000-7000-8000-000000000001",
      uri: "uploads://@/map.png" as const,
      locationRevision: "r1",
    };
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "composerReference",
              attrs: {
                reference: {
                  documentId: upload.documentId,
                  uri: upload.uri,
                  fileType: "image",
                  authority: { kind: "none", projectId: "p" },
                  label: "map",
                  spelling: "[[map]]",
                  imageCapable: true,
                  upload,
                },
              },
            },
          ],
        },
      ],
    };
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 1,
        doc,
        selection: { anchor: 1, head: 2 },
        ownedUploads: [upload],
      }),
    );
    await send();
    expect(deleteDraft).not.toHaveBeenCalled();
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 2,
        doc,
        selection: { anchor: 1, head: 2 },
        ownedUploads: [upload],
      }),
    );
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 3,
        doc: { type: "doc", content: [{ type: "paragraph" }] },
        selection: { anchor: 1, head: 1 },
        ownedUploads: [],
      }),
    );
    expect(deleteDraft).not.toHaveBeenCalled();
  });
  it.each([
    "click",
    "Enter",
    " ",
  ])("retries the stable intake identity with %s", async (activation) => {
    const intake = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage failed"))
      .mockResolvedValueOnce({
        documentId: "01900000-0000-7000-8000-000000000002",
        uri: "uploads://@/note.txt",
        fileType: "text",
        locationRevision: "r2",
      });
    const port: ComposerUploadPort = { intake };
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: port,
      uploadScope: { kind: "none", projectId: "p" },
    });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["note"], "note.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const failed = host.querySelector('[data-composer-upload="failed"]') as HTMLElement;
    expect(failed).toBeInstanceOf(HTMLButtonElement);
    expect(
      (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () =>
      failed.dispatchEvent(
        activation === "click"
          ? new MouseEvent("click", { bubbles: true })
          : new KeyboardEvent("keydown", { key: activation, bubbles: true, cancelable: true }),
      ),
    );
    expect(intake).toHaveBeenCalledTimes(2);
    expect(intake.mock.calls[1]?.[0].intakeId).toBe(intake.mock.calls[0]?.[0].intakeId);
    expect(ref.current?.snapshot().ownedUploads[0]).toMatchObject({ locationRevision: "r2" });
  });

  it("enables prose with a finalized No Work upload only after its intake settles", async () => {
    let resolveIntake!: (value: {
      documentId: string;
      uri: `uploads://${string}`;
      fileType: "image";
      locationRevision: string;
    }) => void;
    const intake = vi.fn(
      () =>
        new Promise<{
          documentId: string;
          uri: `uploads://${string}`;
          fileType: "image";
          locationRevision: string;
        }>((resolve) => {
          resolveIntake = resolve;
        }),
    );
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: { intake },
      uploadScope: { kind: "none", projectId: "p" },
    });
    await act(async () => ref.current?.restoreSnapshot(textSnapshot("Opening", 1)));
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["map"], "map.png", { type: "image/png" })],
    });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const sendButton = host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(intake).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "none", projectId: "p" } }),
    );

    await act(async () =>
      resolveIntake({
        documentId: "01900000-0000-7000-8000-000000000003",
        uri: "uploads://@/map.png",
        fileType: "image",
        locationRevision: "r3",
      }),
    );
    expect(sendButton.disabled).toBe(false);
  });
});

describe("Composer reference gestures", () => {
  it("follows on the first click or Enter, and right-click removes only the second occurrence", async () => {
    const onOpenReference = vi.fn();
    const onSubmit = vi.fn((e: ComposerSubmitEnvelope) => outcome(e, "accepted"));
    const ref = await mount(onSubmit, { onOpenReference });
    const reference = {
      documentId: "01900000-0000-7000-8000-000000000009",
      uri: "manuscript://@/gate.md" as const,
      authority: { kind: "project" as const, projectId: "p" },
      label: "Gate",
      fileType: "markdown" as const,
    };
    await act(async () => {
      ref.current?.insertReference(reference, "[[Gate]]");
      ref.current?.insertReference(reference, "manuscript://@/gate.md");
    });
    const tokens = host.querySelectorAll<HTMLElement>("[data-composer-reference]");
    expect(tokens).toHaveLength(2);
    await act(async () => tokens[1]?.click());
    expect(onOpenReference).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () =>
      tokens[1]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(onOpenReference).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () =>
      tokens[1]?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      ),
    );
    expect(onOpenReference).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(reference.uri);
    await act(async () =>
      document
        .querySelector('[role="menu"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    // Radix restores focus in the task after its menu focus scope unmounts.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(tokens[1]);
    await act(async () =>
      tokens[1]?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onOpenReference).toHaveBeenCalledTimes(2);
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Remove reference",
    );
    expect(remove).toBeDefined();
    await act(async () => remove?.click());
    expect(ref.current?.getDraft()).toBe("[[Gate]]");
    await act(async () =>
      host.querySelector(".tiptap")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(ref.current?.getDraft()).toBe("[[Gate]]manuscript://@/gate.md");
  });
});

it("hands context-menu focus to the Change reference picker", async () => {
  const ref = await mount((e) => outcome(e, "accepted"), {
    referenceCatalog: {
      port: {
        read: () => null,
        acquire: vi.fn(),
        subscribe: () => () => {},
        status: () => "ready",
      },
      openContext: () => ({ warmScopes: [] }),
      label: "References",
    },
  });
  await act(async () =>
    ref.current?.insertReference(
      {
        documentId: "01900000-0000-7000-8000-000000000009",
        uri: "manuscript://gate.md",
        authority: { kind: "project", projectId: "p" },
        label: "Gate",
        fileType: "markdown",
      },
      "[[Gate]]",
    ),
  );
  const token = host.querySelector<HTMLElement>("[data-composer-reference]");
  await act(async () =>
    token?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  const change = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Change reference",
  );
  expect(change).toBeDefined();
  await act(async () => change?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  const input = document.querySelector('input[aria-label="Change reference"]');
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("No matching files");
});

it("edits display text without changing occurrence identity and undoes the edit", async () => {
  const open = vi.fn();
  const ref = await mount((e) => outcome(e, "accepted"), { onOpenReference: open });
  const reference = {
    documentId: "01900000-0000-7000-8000-000000000009",
    uri: "scratch://@work/guide.md",
    authority: { kind: "project" as const, projectId: "p" },
    label: "Guide",
    fileType: "markdown" as const,
  };
  await act(async () => ref.current?.insertReference(reference, "[[Guide]]"));
  const token = host.querySelector<HTMLElement>("[data-composer-reference]");
  await act(async () =>
    token?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 })),
  );
  const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Edit display text",
  );
  expect(edit).toBeDefined();
  await act(async () => edit?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const input = document.querySelector<HTMLInputElement>("input[id]");
  expect(input?.value).toBe("Guide");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "My ] guide",
    );
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(ref.current?.getDraft()).toBe("[[Guide|My \\] guide]]");
  const renamed = host.querySelector<HTMLElement>("[data-composer-reference]");
  expect(renamed?.textContent).toBe("My ] guide");
  await act(async () => renamed?.click());
  expect(open.mock.calls[0]?.[0]).toMatchObject(reference);
  await act(async () =>
    host
      .querySelector(".tiptap")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
  );
  expect(ref.current?.getDraft()).toBe("[[Guide]]");
});
