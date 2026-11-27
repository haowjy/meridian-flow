import { t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts";
import { readSegment, type UploadIntakeResult } from "@meridian/contracts/protocol";
import { imageCapable } from "@meridian/thread-client";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { type Editor, EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
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
} from "@/client/chat-submissions/composer-document";
import { FailureCard } from "@/components/app/FailureCard";
import { IconButton } from "@/components/ui/icon-button";
import type {
  DocumentReference,
  ReferenceTerminalRow,
  StableReferenceAuthority,
} from "@/core/completion";
import { ChromeKernelExtension, getEditorChrome } from "@/core/editor/chrome";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";
import { AtReferenceExtension } from "@/core/editor/extensions/at-reference";
import { referenceDropDoor } from "@/core/editor/extensions/reference-drop";
import { LandingExtension } from "@/core/editor/landing/LandingExtension";
import { editorSuggestionHost } from "@/core/editor/suggestion-host";
import { uploads } from "@/core/uploads/upload-store";
import { joinMain } from "@/features/editor/focus-on-open";
import { AtReferenceMenu } from "@/features/editor/surfaces/link/AtReferenceMenu";
import { referenceDropOptions } from "@/features/project/context/entry-drag/reference-drop-options";
import { useOptionalPanePlace } from "@/features/project/pane-place";
import { cn } from "@/lib/utils";
import { ComposerReferenceMenu } from "./ComposerReferenceMenu";
import { ComposerSkillAtom } from "./ComposerSkillAtom";
import { ConnectionLine } from "./ConnectionLine";
import {
  type ComposerAvailableSkill,
  type ComposerChatCommand,
  ComposerCommandExtension,
  ComposerCommandMenu,
  composerChatCommandItems,
  composerSkillCommandItems,
  matchComposerChatCommand,
} from "./command";
import { useComposerPlaceholder } from "./placeholders";
import { type DroppedEntry, useFileDrop } from "./use-file-drop";
import { useLiveReferences } from "./useLiveReferences";

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

function composerReferenceNode(schema: Schema, row: ReferenceTerminalRow): PMNode {
  return schema.nodeFromJSON(
    composerReferenceContent(
      pickedReferenceAttrs(row.action.reference, row.kind === "file" ? row.fileKind : null),
    ),
  );
}

function uploadChips(editor: Editor): Map<string, number> {
  const chips = new Map<string, number>();
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "composerUpload")
      chips.set((node.attrs.upload as ComposerPendingUploadAttrs).intakeId, pos);
  });
  return chips;
}

function uploadLabel(uri: UploadIntakeResult["uri"], fallback: string): string {
  const parsed = parseContextUri(uri);
  if (!parsed.ok) return fallback;
  const name = readSegment(parsed.value.path.split("/").at(-1) ?? "").name;
  return name || fallback;
}
export type ComposerUploadPort = Readonly<{
  intake: (input: {
    file: File;
    intakeId: string;
    scope: ComposerUploadScope;
    signal: AbortSignal;
  }) => Promise<UploadIntakeResult>;
}>;

export type ComposerProps = {
  initialDraft?: ComposerDraftSnapshot | null;
  externalChange?: { seq: number; draft: ComposerDraftSnapshot | null };
  onSubmit: (envelope: ComposerSubmitEnvelope) => Promise<boolean>;
  onOpenReference?: (reference: DocumentReference) => void;
  onDraftChange?: (change: ComposerDraftChange) => void;
  onStop?: () => void;
  running?: boolean;
  stopStatus?: "idle" | "pending" | "stopping" | "failed";
  placeholder?: string;
  autoFocus?: boolean;
  toolbarLeft?: ReactNode;
  submitDisabled?: boolean;
  busy?: boolean;
  submitDisabledReason?: string;
  uploadScope?: ComposerUploadScope;
  uploadPort?: ComposerUploadPort;
  referenceCatalog?: ReferenceBrowserCatalog | null;
  availableSkills?: readonly ComposerAvailableSkill[] | null;
  commands?: readonly ComposerChatCommand[] | null;
  cards?: ReactNode;
  attached?: ReactNode;
  fileDropActive?: boolean;
  takeover?: ReactNode;
};
export type ComposerHandle = {
  focus: () => void;
  insertReference: (reference: DocumentReference, fileKind: "document" | "asset") => void;
  startWith: (
    reference: DocumentReference,
    fileKind: "document" | "asset",
    replaces: string | null,
  ) => boolean;
  attachFiles: (entries: readonly DroppedEntry[]) => void;
  removeReferences: (documentId: string) => void;
  getDraft: () => string;
  hasContent: () => boolean;
  snapshot: () => ComposerDraftSnapshot;
  appendText: (text: string) => void;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    onSubmit,
    onDraftChange,
    onStop,
    running = false,
    stopStatus = "idle",
    placeholder,
    autoFocus = true,
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
    fileDropActive = false,
    takeover,
  } = props;
  const rotatingPlaceholder = useComposerPlaceholder(running);
  const [initialDraft] = useState(props.initialDraft);
  const regionRef = useRef<HTMLDivElement>(null);
  const revision = useRef(initialDraft?.revision ?? 0);
  const appliedChange = useRef(props.externalChange?.seq);
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
  const [holder] = useState(() => crypto.randomUUID());
  const [submitFailure, setSubmitFailure] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [hasContent, setHasContent] = useState(() => {
    if (!initialDraft) return false;
    const projection = serializeComposerDraft(initialDraft.doc);
    return projection.text.length > 0 || projection.references.length > 0;
  });
  const disabledReasonId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ hardBreak: {}, dropcursor: false }),
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
            referenceNode: composerReferenceNode,
          };
        },
        suggestionHost: (current) => editorSuggestionHost(current, "prose"),
      }),
      LandingExtension.configure({
        entries: referenceDropDoor(
          referenceDropOptions({
            catalog: () => {
              const catalog = referenceCatalogRef.current;
              return catalog && { ...catalog, referenceNode: composerReferenceNode };
            },
            labels: {
              accept: t`Mention`,
              unavailable: t`Can’t mention that here`,
              code: t`This part of the message can’t hold mentions`,
            },
          }),
        ),
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
    // Autofocus must be false, not true; undefined keeps Tiptap's restored selection
    autofocus: autoFocus ? undefined : false,
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
          // PreventDefault on Enter so ProseMirror's keymap doesn't eat the failed-upload button's action
          event.preventDefault();
          target.click();
          return true;
        },
        click: (_view, event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest("[data-composer-upload=failed]")
              : null;
          if (!target) return false;
          const intakeId = target.getAttribute("data-intake-id");
          if (!intakeId) return false;
          uploads.retry(intakeId);
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
  useLiveReferences(editor, initialDraft, referenceCatalog);
  const inMain = useOptionalPanePlace() === "main";
  useEffect(() => {
    if (inMain && editor && !editor.isDestroyed) return joinMain(editor.view.dom, { text: true });
  }, [editor, inMain]);
  useLayoutEffect(() => {
    if (editor && initialDraft) restoreComposerSelection(editor, initialDraft.selection);
  }, [editor, initialDraft]);
  const external = props.externalChange;
  useLayoutEffect(() => {
    if (!editor || !external || external.seq === appliedChange.current) return;
    appliedChange.current = external.seq;
    const { draft } = external;
    queueMicrotask(() => {
      if (editor.isDestroyed) return;
      const { state } = editor;
      const next = editor.schema.nodeFromJSON(
        draft?.doc ?? { type: "doc", content: [{ type: "paragraph" }] },
      );
      const grew = next.content.size - state.doc.content.size;
      const above = grew > 0 && next.content.cut(grew).eq(state.doc.content);
      const tr = state.tr.setMeta("addToHistory", false);
      if (above) tr.insert(0, next.content.cut(0, grew));
      else tr.replaceWith(0, state.doc.content.size, next.content);
      if (draft && !(above && editor.isFocused))
        tr.setSelection(TextSelection.create(tr.doc, draft.selection.anchor, draft.selection.head));
      suppressDraftChangeRef.current = true;
      editor.view.dispatch(tr);
      suppressDraftChangeRef.current = false;
      if (draft) revision.current = draft.revision;
      const active = document.activeElement;
      const focusFree =
        !active || active === document.body || !!regionRef.current?.contains(active);
      if (draft && !editor.isFocused && focusFree) {
        editor.commands.focus("end", { scrollIntoView: false });
      }
    });
  }, [editor, external]);
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
      startWith: (reference, fileKind, replaces) => {
        if (!editor || editor.isDestroyed) return false;
        const fits = () => {
          const doc = editor.state.doc;
          const only = doc.childCount === 1 ? doc.firstChild : null;
          const chip =
            only?.type.name === "paragraph" &&
            only.childCount === 1 &&
            only.firstChild?.type.name === "composerReference"
              ? (only.firstChild.attrs.reference as ComposerReferenceAttrs)
              : null;
          const chipOf = chip?.kind === "document" && !chip.upload ? chip.documentId : null;
          if (chipOf === reference.documentId) return "already";
          // Editor.isEmpty counts an upload-only paragraph as empty; check childCount instead
          const empty = only?.type.name === "paragraph" && only.childCount === 0;
          return empty || (chipOf !== null && chipOf === replaces) ? "fits" : "taken";
        };
        const now = fits();
        if (now !== "fits") return now === "already";
        // Microtask keeps Tiptap's React node view out of a commit; setContent selects the draft, so place the caret after the chip
        queueMicrotask(() => {
          if (editor.isDestroyed || fits() !== "fits") return;
          editor
            .chain()
            .setContent({
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [composerReferenceContent(pickedReferenceAttrs(reference, fileKind))],
                },
              ],
            })
            .command(({ tr }) => {
              tr.setSelection(TextSelection.atEnd(tr.doc));
              return true;
            })
            .run();
        });
        return true;
      },
      attachFiles: (entries) => attachFilesRef.current(entries),
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
      appendText: (text) => {
        if (!editor || editor.isDestroyed || !text) return;
        const [paragraph] = plainComposerDoc(text).content ?? [];
        if (!paragraph) return;
        if (hasContent) editor.commands.insertContentAt(editor.state.doc.content.size, paragraph);
        else editor.commands.setContent({ type: "doc", content: [paragraph] });
      },
    }),
    [editor, hasContent, snapshot],
  );
  const [uploadsHeld, setUploadsHeld] = useState<"sending" | "failed" | null>(null);
  useEffect(() => {
    if (!editor) return;
    const watch = uploads.watch(holder, () => new Set(uploadChips(editor).keys()));
    const sync = () => {
      const states = [...uploadChips(editor).keys()].map(
        (id) => uploads.read(id)?.kind ?? "failed",
      );
      setUploadsHeld(
        states.includes("uploading") ? "sending" : states.includes("failed") ? "failed" : null,
      );
    };
    const changed = () => {
      watch.changed();
      sync();
    };
    editor.on("update", changed);
    const unsubscribe = uploads.subscribe(sync);
    return () => {
      editor.off("update", changed);
      unsubscribe();
      watch.release();
      uploads.discardHeld(holder);
    };
  }, [editor, holder]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function submit() {
    if (!editor || takeover || submitDisabled || uploadsHeld || inFlight.current || !hasContent)
      return;
    const envelope = serializeComposerDraft(
      editor.getJSON(),
      revision.current,
      composerSelection(editor.state.selection),
    );
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

  function attach(file: File) {
    const port = resolvedUploadPort;
    const scope = scopeRef.current;
    if (!editor || !port || !scope) return;
    const intakeId = crypto.randomUUID();
    uploads.begin(intakeId, holder, async (signal) => {
      const ready = await port.intake({ file, intakeId, scope, signal });
      const position = editor.isDestroyed ? undefined : uploadChips(editor).get(intakeId);
      if (position === undefined) throw new Error(t`The upload was stopped.`);
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
            },
          }),
        )
        .run();
    });
    insertChip({ intakeId, name: file.name });
  }
  function insertChip(upload: ComposerPendingUploadAttrs) {
    editor?.chain().focus().insertContent({ type: "composerUpload", attrs: { upload } }).run();
  }
  function refuseFolder(name: string) {
    const intakeId = crypto.randomUUID();
    uploads.refuse(intakeId, holder, t`Folders can't be attached`);
    insertChip({ intakeId, name });
  }

  function attachFiles(entries: readonly DroppedEntry[]) {
    if (!editor || !resolvedUploadPort || !scopeRef.current) return;
    entries.forEach((entry, index) => {
      if (index > 0) editor.commands.insertContent(" ");
      if (entry.kind === "folder") refuseFolder(entry.name);
      else attach(entry.file);
    });
  }
  const attachFilesRef = useRef(attachFiles);
  attachFilesRef.current = attachFiles;
  const fileDrop = useFileDrop({
    enabled: Boolean(resolvedUploadPort && uploadScope),
    onDrop: attachFiles,
  });
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
    <div ref={regionRef} className="contents">
      {cards || failureCard ? (
        <div className="mb-[var(--chat-space-inline)] flex flex-col gap-[var(--chat-space-inline)]">
          {cards}
          {failureCard}
        </div>
      ) : null}
      {attached}
      {takeover}
      <div
        data-composer=""
        {...fileDrop.dropProps}
        hidden={takeover && !focusWithin ? true : undefined}
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
        }}
        className={cn(
          "border border-border bg-card px-[var(--chat-card-pad-x)] pt-[var(--chat-card-pad-y)] pb-[var(--chat-card-pad-y)] focus-within:border-focus",
          "rounded-xl",
          (fileDrop.over || fileDropActive) && "border-focus bg-ink-fill-strong",
          takeover && "sr-only",
        )}
        aria-busy={busy || uploadsHeld === "sending" || undefined}
      >
        <EditorContent
          editor={editor}
          data-placeholder={placeholder ?? rotatingPlaceholder}
          onKeyDownCapture={keyDown}
        />
        {editor ? <AtReferenceMenu editor={editor} /> : null}
        {editor ? <ComposerCommandMenu editor={editor} /> : null}
        <ConnectionLine />
        <div className="mt-[var(--chat-space-inline)] flex items-center gap-[var(--chat-space-inline)]">
          <div className="min-w-0 flex-1">{toolbarLeft}</div>
          {resolvedUploadPort ? (
            <>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                onChange={(event) => {
                  attachFiles(
                    Array.from(event.target.files ?? [], (file) => ({ kind: "file", file })),
                  );
                  event.target.value = "";
                }}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label={t`Attach file`}
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip />
              </IconButton>
            </>
          ) : null}

          {showStop ? (
            <IconButton
              type="button"
              variant="default"
              size="sm"
              data-composer-stop=""
              onClick={() => {
                editor?.commands.focus("end", { scrollIntoView: false });
                onStop?.();
              }}
              disabled={stopInProgress}
              label={
                stopInProgress ? t`Stopping` : stopStatus === "failed" ? t`Couldn't stop` : t`Stop`
              }
              className="relative rounded-full"
            >
              <span className="size-2.5 rounded-sm bg-primary-foreground" />
              {stopInProgress ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-1 rounded-full border-2 border-primary/40 border-t-primary motion-safe:animate-spin"
                />
              ) : null}
            </IconButton>
          ) : null}
          {!showStop ? (
            <IconButton
              type="button"
              variant="default"
              size="sm"
              onClick={() => void submit()}
              disabled={!hasContent || submitDisabled || uploadsHeld !== null}
              label={t`Send message`}
              aria-describedby={submitDisabledReason ? disabledReasonId : undefined}
              className={running ? "relative rounded-full" : "rounded-lg"}
            >
              <ArrowUp />
              {running ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-1 rounded-full border-2 border-primary/40 border-t-primary motion-safe:animate-spin"
                />
              ) : null}
            </IconButton>
          ) : null}
          {submitDisabledReason ? (
            <span id={disabledReasonId} className="sr-only">
              {submitDisabledReason}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});
