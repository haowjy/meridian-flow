/** Shared TipTap draft owner for every message-authoring surface. */

import { t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts";
import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import { imageCapable } from "@meridian/thread-client";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ArrowUp, Paperclip } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FailureCard } from "@/components/app/FailureCard";
import { Button } from "@/components/ui/button";
import type { DocumentReference, StableReferenceAuthority } from "@/core/completion";
import { ChromeKernelExtension, getEditorChrome } from "@/core/editor/chrome";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import { AtReferenceExtension } from "@/core/editor/extensions/at-reference";
import { ReferenceDropExtension } from "@/core/editor/extensions/reference-drop";
import { editorSuggestionHost } from "@/core/editor/suggestion-host";
import { AtReferenceMenu } from "@/features/editor/surfaces/link/AtReferenceMenu";
import { activeEntryDrag } from "@/features/project/context/entry-drag/drag-session";
import { clearDragHint, showDragHint } from "@/features/project/context/tree-drop/drag-hint";
import { cn } from "@/lib/utils";
import { ComposerReferenceMenu } from "./ComposerReferenceMenu";
import { ComposerSkillAtom } from "./ComposerSkillAtom";
import {
  type ComposerAvailableSkill,
  type ComposerChatCommand,
  ComposerCommandExtension,
  ComposerCommandMenu,
  composerChatCommandItems,
  composerSkillCommandItems,
  matchComposerChatCommand,
} from "./command";
import {
  type ComposerDraftChange,
  type ComposerDraftSnapshot,
  type ComposerPendingUploadAttrs,
  type ComposerReferenceAttrs,
  ComposerReferenceNode,
  ComposerSkillNode,
  type ComposerSubmitEnvelope,
  ComposerUploadNode,
  composerReferenceContent,
  composerSelection,
  pickedReferenceAttrs,
  plainComposerDoc,
  restoreComposerSelection,
  serializeComposerDraft,
} from "./composer-document";
import { useComposerPlaceholder } from "./placeholders";
import { useRestoredReferences } from "./useRestoredReferences";

export type {
  ComposerDraftChange,
  ComposerDraftRevision,
  ComposerDraftSnapshot,
  ComposerOwnedUpload,
  ComposerSelection,
  ComposerSubmitEnvelope,
} from "./composer-document";
export { serializeComposerDraft } from "./composer-document";

/** Uploads belong to the chat; a New chat's id is minted before its row exists. */
export type ComposerUploadScope = { kind: "chat"; projectId: string; chatId: string };

function authorityForUpload(
  scope: ComposerUploadScope,
  uri: UploadIntakeResult["uri"],
): StableReferenceAuthority {
  const parsed = parseContextUri(uri);
  return {
    kind: "chat",
    projectId: scope.projectId,
    chatId: scope.chatId,
    chatRef:
      parsed.ok && parsed.value.authority.kind === "chat" ? parsed.value.authority.chatRef : null,
  };
}

/** Intake may allocate a free leaf name; the chip must spell the authoritative URI it received. */
function uploadLabel(uri: UploadIntakeResult["uri"], fallback: string): string {
  const parsed = parseContextUri(uri);
  if (!parsed.ok) return fallback;
  const name = parsed.value.path.split("/").at(-1);
  return name || fallback;
}
export type ComposerUploadPort = Readonly<{
  intake: (input: {
    file: File;
    intakeId: string;
    scope: ComposerUploadScope;
  }) => Promise<UploadIntakeResult>;
}>;

export type ComposerProps = {
  /** Hydrated before mounting; later prop changes never replace writer input. */
  initialDraft?: ComposerDraftSnapshot | null;
  onSubmit: (envelope: ComposerSubmitEnvelope) => Promise<boolean>;
  onOpenReference?: (reference: DocumentReference) => void;
  onDraftChange?: (change: ComposerDraftChange) => void;
  onStop?: () => void;
  /**
   * A run is active on this thread (a reply streaming, a compaction, a brief).
   * With the box empty the one button is Stop, and Escape presses it. With text it is Send
   * (spinning ring), and a send queues behind the run.
   */
  running?: boolean;
  /**
   * This tab's Stop request. Pending and stopping read Stopping and do nothing on a press;
   * failed says so beside the control and keeps it, even after the chat goes idle, so the
   * retry stays reachable. All of it shows only while the box is empty; text shows Send.
   */
  stopStatus?: "idle" | "pending" | "stopping" | "failed";
  placeholder?: string;
  autoFocus?: boolean;
  variant?: "hero" | "pinned";
  toolbarLeft?: ReactNode;
  submitDisabled?: boolean;
  busy?: boolean;
  submitDisabledReason?: string;
  uploadScope?: ComposerUploadScope;
  uploadPort?: ComposerUploadPort;
  referenceCatalog?: AtReferenceCatalog | null;
  availableSkills?: readonly ComposerAvailableSkill[] | null;
  /** Chat verbs (`/compact`) the owning surface can run on its thread. */
  commands?: readonly ComposerChatCommand[] | null;
  /** The host's own cards (`FailureCard`s), the card stack, stacked above the box with the Composer's failure. */
  cards?: ReactNode;
  /** Strips joined to the box's top edge (the draft dock); the notes sit above them. */
  attached?: ReactNode;
};
export type ComposerHandle = {
  focus: () => void;
  /** Adds a file the writer picked outside the `@` menu (the chat's uploads list) at the caret. */
  insertReference: (reference: DocumentReference, fileKind: "document" | "asset") => void;
  /** Drops every chip that references the document (a file the writer deleted elsewhere). */
  removeReferences: (documentId: string) => void;
  getDraft: () => string;
  /**
   * Whether the composer holds anything the writer authored, including a
   * reference-only draft whose text projection may be empty. Edit uses this to
   * avoid overwriting a live draft with a restored plain-text copy.
   */
  hasContent: () => boolean;
  snapshot: () => ComposerDraftSnapshot;
  restoreSnapshot: (snapshot: ComposerDraftSnapshot, expectedRevision?: number) => boolean;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    onSubmit,
    onDraftChange,
    onStop,
    running = false,
    stopStatus = "idle",
    placeholder,
    autoFocus,
    variant = "hero",
    toolbarLeft,
    submitDisabled = false,
    busy = false,
    submitDisabledReason,
    uploadScope,
    uploadPort,
    referenceCatalog = null,
    availableSkills = null,
    commands = null,
    cards,
    attached,
  } = props;
  const rotatingPlaceholder = useComposerPlaceholder(running);
  const [initialDraft] = useState(props.initialDraft);
  const revision = useRef(initialDraft?.revision ?? 0);
  const inFlight = useRef<ComposerSubmitEnvelope | null>(null);
  const mountedRef = useRef(true);
  const scopeRef = useRef(uploadScope);
  scopeRef.current = uploadScope;
  const onOpenReferenceRef = useRef(props.onOpenReference);
  onOpenReferenceRef.current = props.onOpenReference;
  const referenceCatalogRef = useRef(referenceCatalog);
  referenceCatalogRef.current = referenceCatalog;
  const availableSkillsRef = useRef(availableSkills);
  availableSkillsRef.current = availableSkills;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const resolvedUploadPort = uploadPort;
  const suppressDraftChangeRef = useRef(false);
  const [pending, setPending] = useState(0);
  const [submitFailure, setSubmitFailure] = useState(false);
  const [hasContent, setHasContent] = useState(() => {
    if (!initialDraft) return false;
    const projection = serializeComposerDraft(initialDraft.doc);
    return projection.text.length > 0 || projection.references.length > 0;
  });
  const disabledReasonId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const intakeFilesRef = useRef(new Map<string, File>());
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ hardBreak: {} }),
      ChromeKernelExtension,
      ComposerReferenceNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(
            (nodeProps) => (
              <ComposerReferenceMenu
                {...nodeProps}
                readRuntime={() => ({
                  onOpen: onOpenReferenceRef.current,
                  catalog: referenceCatalogRef.current,
                })}
              />
            ),
            { update: ({ oldNode, newNode }) => oldNode.eq(newNode) },
          ),
      }),
      ComposerSkillNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(ComposerSkillAtom, {
            update: ({ oldNode, newNode }) => oldNode.eq(newNode),
          }),
      }),
      ComposerUploadNode,
      AtReferenceExtension.configure({
        catalog: () => {
          const catalog = referenceCatalogRef.current;
          if (!catalog) return null;
          return {
            ...catalog,
            insertReference: (current, range, row) => {
              return current
                .chain()
                .focus()
                .insertContentAt(
                  range,
                  composerReferenceContent(
                    pickedReferenceAttrs(
                      row.action.reference,
                      row.kind === "file" ? row.fileKind : null,
                    ),
                  ),
                )
                .run();
            },
          };
        },
        suggestionHost: (current) => editorSuggestionHost(current, "prose"),
      }),
      ReferenceDropExtension.configure({
        activeDrag: activeEntryDrag,
        content: (schema, entries) => {
          const catalog = referenceCatalogRef.current;
          if (!catalog) return null;
          const nodes = entries.map((entry) => {
            const row = catalog.resolveReference(entry.ref);
            return row
              ? schema.nodeFromJSON(
                  pickedReferenceContent(
                    row.action.reference,
                    row.kind === "file" ? row.fileKind : null,
                  ),
                )
              : null;
          });
          return nodes.every((node) => node !== null) ? nodes : null;
        },
        label: (kind) =>
          kind === "accept"
            ? t`Mention`
            : kind === "unavailable"
              ? t`Can’t mention that`
              : t`Can’t mention there`,
        showHint: (owner, verdict, point) => showDragHint(owner, verdict, point),
        clearHint: clearDragHint,
      }),
      ComposerCommandExtension.configure({
        catalog: () => {
          const skills = availableSkillsRef.current;
          const chatCommands = commandsRef.current ?? [];
          if (!skills && chatCommands.length === 0) return null;
          return {
            menuLabel: t`Commands`,
            groupLabels: { skills: t`Skills`, chat: t`Chat` },
            items: [
              ...composerSkillCommandItems(skills ?? []),
              ...composerChatCommandItems(chatCommands),
            ],
            runCommand: (slug) =>
              commandsRef.current?.find((command) => command.slug === slug)?.run(null),
          };
        },
        suggestionHost: (current) => editorSuggestionHost(current, "prose"),
      }),
    ],
    content: initialDraft?.doc ?? { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: autoFocus,
    editorProps: {
      handleDOMEvents: {
        keydown: (_view, event) => {
          const target = event.target;
          if (
            !(target instanceof HTMLButtonElement) ||
            target.dataset.composerUpload !== "failed" ||
            (event.key !== "Enter" && event.key !== " ")
          )
            return false;
          // ProseMirror's Enter keymap otherwise consumes the native button action.
          event.preventDefault();
          target.click();
          return true;
        },
        click: (view, event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest("[data-composer-upload=failed]")
              : null;
          if (!target) return false;
          const intakeId = target.getAttribute("data-intake-id");
          const file = intakeId ? intakeFilesRef.current.get(intakeId) : null;
          if (!file || !intakeId) return false;
          let position = -1;
          view.state.doc.descendants((node, pos) => {
            if (
              node.type.name === "composerUpload" &&
              (node.attrs.upload as ComposerPendingUploadAttrs).intakeId === intakeId
            )
              position = pos;
          });
          if (position >= 0) void attach(file, intakeId, position);
          return true;
        },
      },
      attributes: {
        "aria-label": t`Message`,
        class:
          "composer-input min-h-10 max-h-60 overflow-y-auto px-[var(--chat-space-inline)] py-[var(--chat-space-inline)] outline-none",
      },
    },
    onTransaction: ({ editor: current, transaction }) => {
      if (!transaction.docChanged) return;
      revision.current += 1;
      const envelope = serializeComposerDraft(
        current.getJSON(),
        revision.current,
        composerSelection(current.state.selection),
      );
      setHasContent(envelope.text.length > 0 || envelope.references.length > 0);
      setSubmitFailure(false);
      if (!suppressDraftChangeRef.current)
        onDraftChange?.({ text: envelope.text, snapshot: envelope.draft });
    },
  });
  useRestoredReferences(editor, initialDraft, referenceCatalog);
  useLayoutEffect(() => {
    if (editor && initialDraft) restoreComposerSelection(editor, initialDraft.selection);
  }, [editor, initialDraft]);
  const snapshot = useCallback((): ComposerDraftSnapshot => {
    if (!editor || editor.isDestroyed)
      return {
        revision: revision.current,
        doc: plainComposerDoc(""),
        selection: { anchor: 1, head: 1 },
        ownedUploads: [],
      };
    const envelope = serializeComposerDraft(
      editor.getJSON(),
      revision.current,
      composerSelection(editor.state.selection),
    );
    return envelope.draft;
  }, [editor]);
  const restoreSnapshot = useCallback(
    (value: ComposerDraftSnapshot, expectedRevision?: number) => {
      if (
        !editor ||
        editor.isDestroyed ||
        (expectedRevision !== undefined && expectedRevision !== revision.current)
      )
        return false;
      suppressDraftChangeRef.current = true;
      editor.commands.setContent(value.doc, { emitUpdate: false });
      restoreComposerSelection(editor, value.selection);
      suppressDraftChangeRef.current = false;
      revision.current += 1;
      {
        const projection = serializeComposerDraft(editor.getJSON());
        setHasContent(projection.text.length > 0 || projection.references.length > 0);
      }
      const envelope = serializeComposerDraft(
        editor.getJSON(),
        revision.current,
        composerSelection(editor.state.selection),
      );
      onDraftChange?.({ text: envelope.text, snapshot: envelope.draft });
      return true;
    },
    [editor, onDraftChange],
  );
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (!editor || editor.isDestroyed) return;
        editor.commands.focus(undefined, { scrollIntoView: false });
      },
      insertReference: (reference, fileKind) => {
        if (!editor || editor.isDestroyed) return;
        editor
          .chain()
          .focus()
          .insertContent(composerReferenceContent(pickedReferenceAttrs(reference, fileKind)))
          .run();
      },
      removeReferences: (documentId) => {
        if (!editor || editor.isDestroyed) return;
        const ranges: { from: number; to: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          const reference = node.attrs.reference as ComposerReferenceAttrs;
          if (
            node.type.name === "composerReference" &&
            reference.kind === "document" &&
            reference.documentId === documentId
          )
            ranges.push({ from: pos, to: pos + node.nodeSize });
        });
        if (ranges.length === 0) return;
        const tr = editor.state.tr;
        for (const { from, to } of ranges.reverse()) tr.delete(from, to);
        editor.view.dispatch(tr);
      },
      getDraft: () =>
        editor && !editor.isDestroyed ? serializeComposerDraft(editor.getJSON()).text : "",
      hasContent: () => hasContent,
      snapshot,
      restoreSnapshot,
    }),
    [editor, hasContent, restoreSnapshot, snapshot],
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function submit() {
    if (!editor || submitDisabled || pending || inFlight.current || editor.isEmpty) return;
    const envelope = serializeComposerDraft(
      editor.getJSON(),
      revision.current,
      composerSelection(editor.state.selection),
    );
    // `/compact <instructions>` is a verb, not a message: it runs on the thread
    // and its text leaves the composer at once, like choosing it from the menu.
    const verb = matchComposerChatCommand(envelope.text, commandsRef.current ?? []);
    if (verb) {
      setSubmitFailure(false);
      editor.commands.clearContent(true);
      verb.command.run(verb.instructions);
      editor.commands.focus(undefined, { scrollIntoView: false });
      return;
    }
    inFlight.current = envelope;
    const recorded = await Promise.resolve(onSubmit(envelope)).catch(() => false);
    inFlight.current = null;
    if (!mountedRef.current || editor.isDestroyed) return;
    setSubmitFailure(!recorded);
    if (recorded && revision.current === envelope.acceptedRevision) {
      suppressDraftChangeRef.current = true;
      editor.commands.clearContent(true);
      suppressDraftChangeRef.current = false;
    }
    editor.commands.focus(undefined, { scrollIntoView: false });
  }

  async function attach(file: File, retryIntakeId?: string, retryPosition?: number) {
    if (!editor || !resolvedUploadPort || !scopeRef.current) return;
    const intakeId = retryIntakeId ?? crypto.randomUUID();
    intakeFilesRef.current.set(intakeId, file);
    const attrs: ComposerPendingUploadAttrs = {
      intakeId,
      name: file.name,
      state: "pending",
      error: null,
    };
    if (retryPosition === undefined) {
      editor
        .chain()
        .focus()
        .insertContent({ type: "composerUpload", attrs: { upload: attrs } })
        .run();
    } else {
      editor
        .chain()
        .setNodeSelection(retryPosition)
        .updateAttributes("composerUpload", { upload: attrs })
        .run();
    }
    setPending((n) => n + 1);
    const scope = scopeRef.current;
    try {
      const ready = await resolvedUploadPort.intake({ file, intakeId, scope });
      let position = -1;
      editor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "composerUpload" &&
          (node.attrs.upload as ComposerPendingUploadAttrs).intakeId === intakeId
        )
          position = pos;
      });
      if (position >= 0)
        editor
          .chain()
          .setNodeSelection(position)
          .insertContent(
            composerReferenceContent({
              kind: "document",
              ...ready,
              authority: authorityForUpload(scope, ready.uri),
              label: uploadLabel(ready.uri, file.name),
              imageCapable: imageCapable(ready.fileType),
              upload: {
                intakeId,
                documentId: ready.documentId,
                uri: ready.uri,
                locationRevision: ready.locationRevision,
              },
            }),
          )
          .run();
    } catch (error) {
      editor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "composerUpload" &&
          (node.attrs.upload as ComposerPendingUploadAttrs).intakeId === intakeId
        )
          editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes("composerUpload", {
              upload: {
                ...attrs,
                state: "failed",
                error: error instanceof Error ? error.message : "Upload failed",
              },
            })
            .run();
      });
    } finally {
      setPending((n) => Math.max(0, n - 1));
    }
  }
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const chrome = getEditorChrome(editor);
    if (!chrome) return;
    const send = () => {
      void submitRef.current();
      return true;
    };
    return chrome.registerKeymap({
      id: "composer-submit",
      scope: "document",
      bindings: {
        Enter: send,
        "Mod-Enter": send,
      },
    });
  }, [editor]);

  // One button, as on main: Stop while the box is empty and a reply runs or this tab's Stop is
  // pending, stopping or failed; Send (with the running ring while a reply runs) once there is text.
  // Escape is the Stop button: it stops only while Stop shows, so a draft is never a side effect.
  const showStop = (running || stopStatus !== "idle") && !hasContent;
  const stopInProgress = stopStatus === "pending" || stopStatus === "stopping";
  const keyDown = (event: React.KeyboardEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest(
        "[data-composer-reference], [data-composer-skill], [data-composer-upload]",
      )
    )
      return;
    if (event.key === "Escape" && showStop && !stopInProgress) {
      event.preventDefault();
      onStop?.();
    }
  };
  const failureCard = submitFailure ? (
    <FailureCard
      tone="error"
      onDismiss={() => {
        setSubmitFailure(false);
        editor?.commands.focus(undefined, { scrollIntoView: false });
      }}
    >
      <p className="min-w-0 flex-1">{t`Couldn't send.`}</p>
    </FailureCard>
  ) : null;
  return (
    <>
      {cards || failureCard ? (
        // Above the box and its strips, as wide as the box: every note above the box is the
        // same card in the same place, whoever raised it. Send is the failure's retry.
        <div className="mb-[var(--chat-space-inline)] flex flex-col gap-[var(--chat-space-inline)]">
          {cards}
          {failureCard}
        </div>
      ) : null}
      {attached}
      <div
        data-composer=""
        className={cn(
          "border border-composer-border bg-composer-surface px-[var(--chat-card-pad-x)] pt-[var(--chat-card-pad-y)] pb-[var(--chat-card-pad-y)] focus-within:border-border-focus",
          variant === "hero" ? "rounded-composer" : "rounded-composer-pinned",
        )}
        aria-busy={busy || pending > 0 || undefined}
      >
        <EditorContent
          editor={editor}
          data-placeholder={placeholder ?? rotatingPlaceholder}
          onKeyDownCapture={keyDown}
        />
        {editor ? <AtReferenceMenu editor={editor} /> : null}
        {editor ? <ComposerCommandMenu editor={editor} /> : null}
        <div className="mt-[var(--chat-space-inline)] flex items-center gap-[var(--chat-space-inline)]">
          <div className="min-w-0 flex-1">{toolbarLeft}</div>
          {resolvedUploadPort ? (
            <>
              <input
                ref={fileRef}
                className="sr-only"
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void attach(file);
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t`Attach file`}
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip className="size-4" />
              </Button>
            </>
          ) : null}

          {showStop ? (
            <Button
              type="button"
              size="icon-sm"
              data-composer-stop=""
              onClick={() => onStop?.()}
              disabled={stopInProgress}
              aria-label={
                stopInProgress
                  ? t`Stopping`
                  : stopStatus === "failed"
                    ? t`Couldn't stop. Try again.`
                    : t`Stop`
              }
              className="relative rounded-full"
            >
              <span className="size-2.5 rounded-[3px] bg-primary-foreground" />
              {stopInProgress ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-1 rounded-full border-2 border-primary/30 border-t-primary motion-safe:animate-spin"
                />
              ) : null}
            </Button>
          ) : null}
          {!showStop ? (
            <Button
              type="button"
              size="icon-sm"
              onClick={() => void submit()}
              disabled={!hasContent || submitDisabled || pending > 0}
              aria-label={t`Send message`}
              aria-describedby={submitDisabledReason ? disabledReasonId : undefined}
              className={running ? "relative rounded-full" : "rounded-field"}
            >
              <ArrowUp className="size-4" />
              {running ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-1 rounded-full border-2 border-primary/30 border-t-primary motion-safe:animate-spin"
                />
              ) : null}
            </Button>
          ) : null}
          {submitDisabledReason ? (
            <span id={disabledReasonId} className="sr-only">
              {submitDisabledReason}
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
});
