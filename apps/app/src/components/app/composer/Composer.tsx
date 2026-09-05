/** Shared TipTap draft owner for every message-authoring surface. */
import { t } from "@lingui/core/macro";
import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ArrowUp, Paperclip, RotateCcw } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import type { AuthoritativeReference } from "@/core/completion";
import { ChromeKernelExtension } from "@/core/editor/chrome";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import { AtReferenceExtension } from "@/core/editor/extensions/at-reference";
import { editorSuggestionHost } from "@/core/editor/suggestion-host";
import { AtReferenceMenu } from "@/features/editor/surfaces/link/AtReferenceMenu";
import { cn } from "@/lib/utils";
import {
  type ComposerDraftChange,
  type ComposerDraftSnapshot,
  type ComposerOwnedUpload,
  type ComposerPendingUploadAttrs,
  ComposerReferenceNode,
  type ComposerSubmitEnvelope,
  ComposerUploadNode,
  composerOwnedUploadReferences,
  composerReferenceContent,
  composerSelection,
  mergeComposerDraftSnapshots,
  plainComposerDoc,
  restoreComposerSelection,
  serializeComposerDraft,
} from "./composer-document";
import { useComposerPlaceholder } from "./placeholders";

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
  | Readonly<{ kind: "ambiguous"; submissionId: string; acceptedRevision: number }>;

export type ComposerUploadScope = Extract<
  AuthoritativeReference["authority"],
  { kind: "work" | "none" }
>;
export type ComposerUploadPort = Readonly<{
  intake: (input: {
    file: File;
    intakeId: string;
    scope: ComposerUploadScope;
  }) => Promise<UploadIntakeResult>;
  deleteDraft: (input: ComposerOwnedUpload, scope: ComposerUploadScope) => Promise<void>;
}>;

export type ComposerProps = {
  onSubmit: (
    envelope: ComposerSubmitEnvelope,
  ) => ComposerSubmitOutcome | Promise<ComposerSubmitOutcome>;
  onDraftChange?: (change: ComposerDraftChange) => void;
  onCheckSubmission?: (envelope: ComposerSubmitEnvelope) => Promise<ComposerSubmitOutcome>;
  onRetireSubmission?: (envelope: ComposerSubmitEnvelope) => Promise<ComposerSubmitOutcome>;
  onStop?: () => void;
  streaming?: boolean;
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
};
export type ComposerHandle = {
  focus: () => void;
  getDraft: () => string;
  snapshot: () => ComposerDraftSnapshot;
  restoreSnapshot: (snapshot: ComposerDraftSnapshot) => boolean;
  restoreFailedSubmission: (
    id: string,
    submitted: ComposerDraftSnapshot,
    later?: ComposerDraftSnapshot | null,
  ) => boolean;
  insertReference: (
    reference: AuthoritativeReference,
    spelling: string,
    imageCapable?: boolean,
  ) => void;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    onSubmit,
    onDraftChange,
    onCheckSubmission,
    onRetireSubmission,
    onStop,
    streaming = false,
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
  } = props;
  const rotatingPlaceholder = useComposerPlaceholder(streaming);
  const revision = useRef(0);
  const restored = useRef(new Set<string>());
  const inFlight = useRef<ComposerSubmitEnvelope | null>(null);
  const [quarantined, setQuarantined] = useState<ComposerSubmitEnvelope | null>(null);
  const mountedRef = useRef(true);
  const scopeRef = useRef(uploadScope);
  scopeRef.current = uploadScope;
  const referenceCatalogRef = useRef(referenceCatalog);
  referenceCatalogRef.current = referenceCatalog;
  const resolvedUploadPort = uploadPort;
  const uploadPortRef = useRef(resolvedUploadPort);
  uploadPortRef.current = resolvedUploadPort;
  const suppressDetachRef = useRef(false);
  const suppressDraftChangeRef = useRef(false);
  const [pending, setPending] = useState(0);
  const [locked, setLocked] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const disabledReasonId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const intakeFilesRef = useRef(new Map<string, File>());
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ hardBreak: {} }),
      ChromeKernelExtension,
      ComposerReferenceNode,
      ComposerUploadNode,
      AtReferenceExtension.configure({
        catalog: () => {
          const catalog = referenceCatalogRef.current;
          if (!catalog) return null;
          return {
            ...catalog,
            insertReference: (current, range, row) => {
              const reference = row.action.reference;
              const spelling = row.ambiguous ? reference.uri : `[[${reference.label}]]`;
              return current
                .chain()
                .focus()
                .insertContentAt(
                  range,
                  composerReferenceContent({
                    ...reference,
                    spelling,
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
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: autoFocus,
    editorProps: {
      handleDOMEvents: {
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
      handleClickOn: (_view, position, node) => {
        if (node.type.name !== "composerUpload") return false;
        const value = node.attrs.upload as ComposerPendingUploadAttrs;
        if (value.state !== "failed") return false;
        const file = intakeFilesRef.current.get(value.intakeId);
        if (!file) return false;
        void attach(file, value.intakeId, position);
        return true;
      },
      attributes: {
        "aria-label": t`Message`,
        class: "composer-input min-h-10 max-h-60 overflow-y-auto px-1.5 py-1 outline-none",
      },
    },
    onTransaction: ({ editor: current, transaction }) => {
      if (!transaction.docChanged) return;
      if (!suppressDetachRef.current && uploadPortRef.current && scopeRef.current) {
        const before = composerOwnedUploadReferences(transaction.before.toJSON());
        const afterIds = new Set(
          composerOwnedUploadReferences(current.getJSON()).map(({ upload }) => upload.intakeId),
        );
        for (const removed of before) {
          if (!afterIds.has(removed.upload.intakeId))
            void uploadPortRef.current.deleteDraft(removed.upload, removed.authority);
        }
      }
      revision.current += 1;
      const envelope = serializeComposerDraft(
        current.getJSON(),
        revision.current,
        composerSelection(current.state.selection),
      );
      setHasContent(envelope.text.length > 0 || envelope.references.length > 0);
      if (!suppressDraftChangeRef.current)
        onDraftChange?.({ text: envelope.text, snapshot: envelope.draft });
    },
  });
  const snapshot = useCallback((): ComposerDraftSnapshot => {
    if (!editor)
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
    (value: ComposerDraftSnapshot) => {
      if (!editor) return false;
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
      focus: () => editor?.commands.focus(undefined, { scrollIntoView: false }),
      getDraft: () => (editor ? serializeComposerDraft(editor.getJSON()).text : ""),
      snapshot,
      restoreSnapshot,
      restoreFailedSubmission: (id, submitted, later) => {
        if (restored.current.has(id)) return true;
        if (!editor) return false;
        restored.current.add(id);
        return restoreSnapshot(
          later && later.revision > submitted.revision
            ? mergeComposerDraftSnapshots(submitted, later)
            : submitted,
        );
      },
      insertReference: (reference, spelling, imageCapable = false) => {
        editor
          ?.chain()
          .focus()
          .insertContent(
            composerReferenceContent({ ...reference, spelling, imageCapable, upload: null }),
          )
          .run();
      },
    }),
    [editor, restoreSnapshot, snapshot],
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
      if (outcome.kind === "ambiguous") {
        setQuarantined(envelope);
        setLocked(true);
        return;
      }
      setQuarantined((current) =>
        current?.submissionId === envelope.submissionId ? null : current,
      );
      setLocked(false);
      if (outcome.kind === "accepted" && revision.current === envelope.acceptedRevision) {
        suppressDetachRef.current = true;
        editor.commands.clearContent(true);
        suppressDetachRef.current = false;
      }
      if (outcome.kind === "rejected") {
        const later = snapshot();
        restoreSnapshot(
          later.revision > envelope.draft.revision
            ? mergeComposerDraftSnapshots(envelope.draft, later)
            : envelope.draft,
        );
      }
      editor.commands.focus(undefined, { scrollIntoView: false });
    },
    [editor, restoreSnapshot, snapshot],
  );

  async function submit() {
    if (!editor || submitDisabled || pending || locked || inFlight.current || editor.isEmpty)
      return;
    const envelope = serializeComposerDraft(
      editor.getJSON(),
      revision.current,
      composerSelection(editor.state.selection),
    );
    inFlight.current = envelope;
    const outcome = await Promise.resolve(onSubmit(envelope)).catch(
      (): ComposerSubmitOutcome => ({
        kind: "rejected",
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      }),
    );
    inFlight.current = null;
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
              authority: scope,
              label: file.name,
              spelling: `[[${file.name}]]`,
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
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && streaming) {
      event.preventDefault();
      onStop?.();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (event.metaKey || event.ctrlKey || !streaming)
    ) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <div
      className={cn(
        "border border-composer-border bg-composer-surface px-4 pt-4 pb-3 focus-within:border-border-focus",
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
      <div className="mt-1 flex items-center gap-2">
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
          onClick={() => (streaming ? onStop?.() : void submit())}
          disabled={!streaming && (!hasContent || submitDisabled || pending > 0 || locked)}
          aria-label={streaming ? t`Stop` : t`Send message`}
          aria-describedby={!streaming && submitDisabledReason ? disabledReasonId : undefined}
          className={streaming ? "rounded-full" : "rounded-field"}
        >
          {streaming ? (
            <span className="size-2.5 rounded-[3px] bg-primary-foreground" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
        {submitDisabledReason ? (
          <span id={disabledReasonId} className="sr-only">
            {submitDisabledReason}
          </span>
        ) : null}
      </div>
    </div>
  );
});
