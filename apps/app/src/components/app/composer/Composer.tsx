/** Shared TipTap draft owner for every message-authoring surface. */

import { t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts";
import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ArrowUp, Paperclip, RotateCcw } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import type { AuthoritativeReference, StableReferenceAuthority } from "@/core/completion";
import { ChromeKernelExtension, getEditorChrome } from "@/core/editor/chrome";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import { AtReferenceExtension } from "@/core/editor/extensions/at-reference";
import { editorSuggestionHost } from "@/core/editor/suggestion-host";
import { AtReferenceMenu } from "@/features/editor/surfaces/link/AtReferenceMenu";
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
  ComposerReferenceNode,
  ComposerSkillNode,
  type ComposerSubmitEnvelope,
  ComposerUploadNode,
  composerReferenceContent,
  composerSelection,
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

export type ComposerSubmitOutcome =
  | Readonly<{ kind: "accepted"; submissionId: string; acceptedRevision: number }>
  | Readonly<{ kind: "rejected"; submissionId: string; acceptedRevision: number }>
  | Readonly<{ kind: "ambiguous"; submissionId: string; acceptedRevision: number }>
  | Readonly<{ kind: "not-seen"; submissionId: string; acceptedRevision: number }>;

export type ComposerUploadScope = { kind: "work"; projectId: string; workId: string };

function authorityForUpload(
  scope: ComposerUploadScope,
  uri: UploadIntakeResult["uri"],
): StableReferenceAuthority {
  const parsed = parseContextUri(uri);
  return {
    kind: "work",
    projectId: scope.projectId,
    workId: scope.workId,
    workSlug:
      parsed.ok && parsed.value.authority.kind === "work" ? parsed.value.authority.workSlug : null,
  };
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
  onSubmit: (
    envelope: ComposerSubmitEnvelope,
  ) => ComposerSubmitOutcome | Promise<ComposerSubmitOutcome>;
  onOpenReference?: (reference: AuthoritativeReference) => void;
  onDraftChange?: (change: ComposerDraftChange) => void;
  onCheckSubmission?: (envelope: ComposerSubmitEnvelope) => Promise<ComposerSubmitOutcome>;
  onRetireSubmission?: (envelope: ComposerSubmitEnvelope) => Promise<ComposerSubmitOutcome>;
  onStop?: () => void;
  /**
   * A run is active on this thread (a reply streaming, a compaction, a brief).
   * Stop replaces an empty Send, Escape in the empty composer presses it, and a
   * send queues behind the run.
   */
  running?: boolean;
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
};
export type ComposerHandle = {
  focus: () => void;
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
    onCheckSubmission,
    onRetireSubmission,
    onStop,
    running = false,
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
  } = props;
  const rotatingPlaceholder = useComposerPlaceholder(running);
  const [initialDraft] = useState(props.initialDraft);
  const revision = useRef(initialDraft?.revision ?? 0);
  const inFlight = useRef<ComposerSubmitEnvelope | null>(null);
  const [quarantined, setQuarantined] = useState<ComposerSubmitEnvelope | null>(null);
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
  const [locked, setLocked] = useState(false);
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
              const reference = row.action.reference;
              return current
                .chain()
                .focus()
                .insertContentAt(
                  range,
                  composerReferenceContent({
                    ...reference,
                    imageCapable: row.fileKind === "asset" && reference.fileType === "image",
                    upload: null,
                  }),
                )
                .run();
            },
          };
        },
        suggestionHost: (current) => editorSuggestionHost(current, "prose"),
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

  const settle = useCallback(
    async (envelope: ComposerSubmitEnvelope, outcome: ComposerSubmitOutcome) => {
      if (!editor || !mountedRef.current || editor.isDestroyed) return;
      if (
        outcome.submissionId !== envelope.submissionId ||
        outcome.acceptedRevision !== envelope.acceptedRevision
      )
        return;
      if (outcome.kind === "ambiguous" || outcome.kind === "not-seen") {
        setQuarantined(envelope);
        setLocked(true);
        return;
      }
      setQuarantined((current) =>
        current?.submissionId === envelope.submissionId ? null : current,
      );
      setLocked(false);
      if (outcome.kind === "accepted" && revision.current === envelope.acceptedRevision) {
        editor.commands.clearContent(true);
      }
      // Send never removed the live document. A rejection leaves the writer's
      // edits intact; prepending the submitted snapshot would duplicate words.
      if (outcome.kind === "rejected") {
        const retained = snapshot();
        onDraftChange?.({ text: serializeComposerDraft(retained.doc).text, snapshot: retained });
      }
      editor.commands.focus(undefined, { scrollIntoView: false });
    },
    [editor, onDraftChange, snapshot],
  );

  async function submit() {
    if (!editor || submitDisabled || pending || locked || inFlight.current || editor.isEmpty)
      return;
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
    const outcome = await Promise.resolve(onSubmit(envelope)).catch(
      (): ComposerSubmitOutcome => ({
        kind: "rejected",
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      }),
    );
    inFlight.current = null;
    // A rejected send is not cleared: keep the draft and surface the local
    // failure on the composer instead of silently dropping it.
    setSubmitFailure(outcome.kind === "rejected");
    await settle(envelope, outcome);
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
              ...ready,
              authority: authorityForUpload(scope, ready.uri),
              label: file.name,
              imageCapable: ready.fileType === "image",
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

  // Escape is the Stop button: it stops only while Stop shows. With a draft it
  // leaves the run and the draft alone for other Escape owners.
  const showStop = running && !hasContent;
  const keyDown = (event: React.KeyboardEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest(
        "[data-composer-reference], [data-composer-skill], [data-composer-upload]",
      )
    )
      return;
    if (event.key === "Escape" && showStop) {
      event.preventDefault();
      onStop?.();
    }
  };
  return (
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
        {quarantined && onCheckSubmission ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Check submission status`}
            onClick={() =>
              void onCheckSubmission(quarantined).then((result) => settle(quarantined, result))
            }
          >
            <RotateCcw className="size-4" />
          </Button>
        ) : null}
        {quarantined && onRetireSubmission ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Start over`}
            onClick={() =>
              void onRetireSubmission(quarantined).then((result) => settle(quarantined, result))
            }
          >
            <span aria-hidden>×</span>
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          onClick={() => (showStop ? onStop?.() : void submit())}
          disabled={!showStop && (!hasContent || submitDisabled || pending > 0 || locked)}
          aria-label={showStop ? t`Stop` : t`Send message`}
          aria-describedby={!showStop && submitDisabledReason ? disabledReasonId : undefined}
          className={running ? "relative rounded-full" : "rounded-field"}
        >
          {showStop ? (
            <span className="size-2.5 rounded-[3px] bg-primary-foreground" />
          ) : (
            <ArrowUp className="size-4" />
          )}
          {running && hasContent ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -inset-1 rounded-full border-2 border-primary/30 border-t-primary motion-safe:animate-spin"
            />
          ) : null}
        </Button>
        {submitDisabledReason ? (
          <span id={disabledReasonId} className="sr-only">
            {submitDisabledReason}
          </span>
        ) : null}
      </div>
      {submitFailure ? (
        <p
          role="alert"
          className="mt-[var(--chat-space-inline)] text-right text-xs text-destructive"
        >
          {t`Couldn't send. Your message was not lost.`}
        </p>
      ) : null}
    </div>
  );
});
