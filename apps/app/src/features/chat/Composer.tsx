/**
 * Composer — shared chat input surface used by home and pinned chat footers.
 * A minimal TipTap input (paragraphs, hard breaks, reference tokens — no
 * marks, no blocks) wearing the textarea's exact clothes: it owns growth and
 * the internal-scroll cap, keyboard submit/stop behaviour, the `@` reference
 * menu, and the send control, while callers own message dispatch and
 * streaming state. The schema, the token, and the serialization live in
 * [`composer-input/`](composer-input/index.ts); this file is the surface.
 *
 * **An open menu owns its keys.** ArrowUp, ArrowDown, Enter and Escape belong
 * to the `@` menu while it is showing rows, so `handleKeyDown` asks it before
 * it submits or stops a stream (§Trigger-composition 2). The composer mounts
 * no chrome kernel to register a layer with, so the precedence is enforced
 * right here — as ProseMirror's first keydown prop, ahead of every plugin —
 * and it is one call, at the top, rather than a condition on each branch.
 */
import { t } from "@lingui/core/macro";
import type { UserMessageBlock } from "@meridian/contracts/threads";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { ArrowUp, TriangleAlert } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { Button } from "@/components/ui/button";
import type { ReferenceCatalog } from "@/core/references";
import { useReferenceCandidates } from "@/features/project/context/useReferenceCandidates";
import { cn } from "@/lib/utils";

import {
  attachableFiles,
  ComposerAttachmentChips,
  type ComposerAttachments,
  ComposerReferenceMenu,
  type ComposerUploadToken,
  closedComposerReferenceMenu,
  composerImageBlocks,
  composerUploadTokens,
  createComposerAttachments,
  createComposerExtensions,
  getComposerReferenceMenu,
  serializeComposerText,
} from "./composer-input";
import "./composer-input/composer-input.css";
import { useComposerPlaceholder } from "./placeholders";

export type ComposerProps = {
  /**
   * Called with the trimmed message text when the user submits a non-empty
   * draft. When the draft carries picture tokens, `blocks` arrives beside it:
   * the same text as one text block, plus one image block per distinct
   * picture. Undefined otherwise, so a plain message stays a plain string.
   */
  onSubmit: (text: string, blocks?: UserMessageBlock[]) => void;
  /** Called when the user clicks the stop control while a turn is running. */
  onStop?: () => void;
  /**
   * True while an assistant turn is streaming. Flips the action button from the
   * square "send" control into the circular "stop" control, and disables
   * Enter-to-submit. Defaults to false.
   */
  streaming?: boolean;
  /** Placeholder shown while the draft is empty. */
  placeholder?: string;
  /** Focus the input on mount (the Home hero uses this). */
  autoFocus?: boolean;
  /**
   * Visual treatment. `hero` is the prominent Home surface (large shadow, taller
   * default height); `pinned` is the compact footer used by the ChatView.
   * Behaviour is identical across variants.
   */
  variant?: "hero" | "pinned";
  /** Footer toolbar slot for caller-owned controls such as the agent selector. */
  toolbarLeft?: ReactNode;
  /**
   * The project whose documents `@` can name, and the Work whose scratch is in
   * reach. Absent on the Home hero, where there is no project yet and `@` is
   * ordinary prose.
   */
  projectId?: string | null;
  workId?: string | null;
  /**
   * The thread pasted files attach to (paste-time upload into the thread's
   * primary Work `uploads://`). Absent on the Home hero, where no thread
   * exists yet and pasting a file stays inert.
   */
  threadId?: string | null;
  /**
   * Whether the thread's model can view pictures (the `image_input`
   * capability, read off the thread snapshot). False shows a quiet hint under
   * a draft carrying picture tokens — informational only, never a gate: the
   * server degrades the same way, dropping the image and keeping the text.
   * Null or undefined means unknown (no thread yet), which shows nothing.
   */
  modelSupportsImageInput?: boolean | null;
};

/** Imperative handle exposed by ref so hosts can reach the input. */
export type ComposerHandle = {
  focus: () => void;
  /**
   * The input's engine, for a host (or a test) that must drive it directly —
   * the attachments slices subscribe a chip row to its document through this.
   * Null until the client-side editor has mounted.
   */
  editor: Editor | null;
};

/** Listbox id, the prefix every option id carries, and what a probe looks for. */
const MENU_ID = "composer-reference-menu";

/** Everything the mount-stable editor callbacks read off the live render. */
type ComposerRuntime = {
  editor: Editor | null;
  catalog: ReferenceCatalog | null;
  placeholder: string;
  streaming: boolean;
  threadId: string | null;
  attachments: ComposerAttachments | null;
  /** True while a submit is quietly awaiting in-flight uploads. */
  sending: boolean;
  /** Filenames of failed uploads a submit ran into — the ratified send hold. */
  holdSend: (failedNames: string[] | null) => void;
  onSubmit: (text: string, blocks?: UserMessageBlock[]) => void;
  onStop: (() => void) | undefined;
};

/**
 * The shared notebook composer: an auto-growing message box with a send button
 * that morphs from a rounded square (send) into a circle (stop) while a turn is
 * streaming. Enter submits; Shift+Enter inserts a hard break; Cmd/Ctrl+Enter
 * always submits; Esc cancels a running stream. Clears after a successful
 * submit. A pick from the `@` menu inserts an atomic reference token —
 * backspace at its edge removes the whole thing, and hand-typed `[[…]]` or
 * URI text stays exactly the plain text the writer typed.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    onSubmit,
    onStop,
    streaming = false,
    placeholder,
    autoFocus = false,
    variant = "hero",
    toolbarLeft,
    projectId = null,
    workId = null,
    threadId = null,
    modelSupportsImageInput = null,
  },
  ref,
) {
  const rotatingPlaceholder = useComposerPlaceholder(streaming);
  const resolvedPlaceholder = placeholder ?? rotatingPlaceholder;
  const { candidates } = useReferenceCandidates({ projectId, workId });
  const frameRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [canSend, setCanSend] = useState(false);
  const [draftHasPictures, setDraftHasPictures] = useState(false);
  const [uploadTokens, setUploadTokens] = useState<ComposerUploadToken[]>([]);
  const [heldUploadNames, setHeldUploadNames] = useState<string[] | null>(null);

  // The editor's callbacks are created once and live for the mount; this ref
  // is how they read the render they are actually running in.
  const runtime = useRef<ComposerRuntime>({
    editor: null,
    catalog: null,
    placeholder: "",
    streaming: false,
    threadId: null,
    attachments: null,
    sending: false,
    holdSend: () => {},
    onSubmit,
    onStop,
  });
  // With no project there is nothing internal to name, so `@` in the Home
  // hero is ordinary prose: a null catalog keeps the trigger silent.
  runtime.current.catalog = projectId ? { label: t`Reference a document`, candidates } : null;
  runtime.current.placeholder = resolvedPlaceholder;
  runtime.current.streaming = streaming;
  runtime.current.threadId = threadId;
  runtime.current.holdSend = setHeldUploadNames;
  runtime.current.onSubmit = onSubmit;
  runtime.current.onStop = onStop;

  // Paste-time upload lifecycle. Created once per mount; reads the live
  // thread through the runtime ref, tells the uploads rail when the server's
  // file set changed.
  const attachments = useMemo(
    () =>
      createComposerAttachments({
        threadId: () => runtime.current.threadId,
        onUploadsChanged: (changedThreadId) =>
          void queryClient.invalidateQueries({
            queryKey: threadQueryKeys.uploads(changedThreadId),
          }),
      }),
    [queryClient],
  );
  runtime.current.attachments = attachments;
  useEffect(() => () => attachments.dispose(), [attachments]);

  const extensions = useMemo(
    () =>
      createComposerExtensions({
        catalog: () => runtime.current.catalog,
        placeholder: () => runtime.current.placeholder,
      }),
    [],
  );

  const editor = useEditor(
    {
      extensions,
      autofocus: autoFocus ? "end" : false,
      // The app server-renders; the editor exists only where a caret can.
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: cn(
            "composer-input max-h-60 overflow-y-auto px-1.5 py-1 outline-none",
            "selection:bg-primary/25 selection:text-foreground",
            variant === "hero" ? "min-h-[52px]" : "min-h-[40px]",
          ),
          role: "textbox",
          "aria-multiline": "true",
        },
        // An open menu owns the arrows, Enter and Escape. Asked first, so a
        // pick is never also a sent message and a dismissal is never also a
        // cancelled turn. Direct props run before every plugin's keymap, which
        // is what makes this the one arbiter.
        handleKeyDown: (view, event) => {
          const current = runtime.current;
          const menu = getComposerReferenceMenu(current.editor);
          // An IME mid-composition owns every key: Enter commits the glyphs,
          // the arrows walk the candidate list. Nothing here may intercept.
          const composing = view.composing || event.isComposing;
          if (!composing && menu && menuKeyDown(menu, event)) return true;

          // Esc cancels the stream when streaming.
          if (event.key === "Escape" && current.streaming) {
            current.onStop?.();
            return true;
          }

          if (event.key === "Enter" && !composing) {
            // Cmd/Ctrl+Enter always submits (multiline-friendly). Plain Enter
            // submits too; while a turn is streaming both are inert — the
            // action button is "stop" — but the key is still swallowed so a
            // newline never sneaks into a message Enter would have sent.
            if (event.metaKey || event.ctrlKey || !event.shiftKey) {
              if (!current.streaming) void submit(current);
              return true;
            }
            // Shift+Enter falls through to the hard-break keymap.
          }
          return false;
        },
        // A paste carrying files attaches them (paste-time upload, ruled);
        // text-only pastes fall through to the plain-text clipboard plugin.
        // Without a thread nothing can hold an upload, so the paste stays
        // whatever the platform makes of it (today: nothing).
        handlePaste: (_view, event) => {
          const current = runtime.current;
          const files = attachableFiles(event.clipboardData);
          if (files.length === 0 || !current.editor || !current.attachments?.canAttach()) {
            return false;
          }
          event.preventDefault();
          return current.attachments.attachFiles(current.editor, files);
        },
        // Dropped files land where they were dropped, same lifecycle as paste.
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const current = runtime.current;
          const files = attachableFiles(event.dataTransfer);
          if (files.length === 0 || !current.editor || !current.attachments?.canAttach()) {
            return false;
          }
          event.preventDefault();
          const drop = view.posAtCoords({ left: event.clientX, top: event.clientY });
          return current.attachments.attachFiles(current.editor, files, drop?.pos);
        },
      },
      onCreate: ({ editor: created }) => {
        runtime.current.editor = created;
      },
      onUpdate: ({ editor: updated }) => {
        runtime.current.attachments?.handleDocChange(updated);
        const doc = updated.state.doc;
        setCanSend(serializeComposerText(doc).trim().length > 0);
        setDraftHasPictures(composerImageBlocks(doc).length > 0);
        const uploads = composerUploadTokens(doc);
        // Unchanged tokens keep their attrs object identity across
        // transactions, so this compare keeps keystrokes from re-rendering.
        setUploadTokens((previous) => (sameTokens(previous, uploads) ? previous : uploads));
        // The hold names failed uploads; once none remain (retried, removed),
        // the message clears itself rather than scolding a solved problem.
        if (!uploads.some((token) => token.upload.state === "failed")) {
          setHeldUploadNames(null);
        }
      },
    },
    [],
  );
  runtime.current.editor = editor;

  // Expose focus() and the engine to hosts (ChatView focuses; chips subscribe).
  useImperativeHandle(ref, () => ({ focus: () => editor?.commands.focus(), editor }), [editor]);

  const menu = getComposerReferenceMenu(editor);
  const snapshot = useSyncExternalStore(
    menu?.subscribe ?? noSubscription,
    () => menu?.snapshot() ?? closedComposerReferenceMenu(),
    closedComposerReferenceMenu,
  );

  // Placeholder decorations repaint on transactions, and a streaming flip
  // changes the text without one — so ask for a paint. The accessible name
  // travels with it: the textarea's `placeholder` named the field, and the
  // contenteditable has no attribute that does both jobs.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dom.setAttribute("aria-label", resolvedPlaceholder);
    editor.view.dispatch(editor.state.tr);
  }, [editor, resolvedPlaceholder]);

  // Which row a screen reader should read. The caret never leaves the input,
  // so the announcement travels from the contenteditable, not the menu.
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    if (!snapshot.open) {
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
      return;
    }
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-controls", MENU_ID);
    const key = snapshot.items[snapshot.activeIndex]?.key;
    if (key) dom.setAttribute("aria-activedescendant", `${MENU_ID}-${key}`);
    else dom.removeAttribute("aria-activedescendant");
  }, [editor, snapshot]);

  const containerClassName = cn(
    "border transition-[border-color] focus-within:border-border-focus",
    variant === "hero"
      ? "rounded-composer border-border bg-card shadow-hero"
      : "rounded-composer-pinned border-composer-border bg-composer-surface",
  );

  return (
    <div ref={frameRef} className={cn("px-4 pt-4 pb-3", containerClassName)}>
      <ComposerAttachmentChips
        tokens={uploadTokens}
        onRemove={(uploadId) => editor && attachments.detach(editor, uploadId)}
        onRetry={(uploadId) => editor && attachments.retry(editor, uploadId)}
      />
      <EditorContent
        editor={editor}
        className={cn("composer-editor", variant === "hero" ? "min-h-[52px]" : "min-h-[40px]")}
      />

      {/* The one ratified hold: a failed upload keeps the message here until
          the writer retries it or removes it — never a silent drop. */}
      {heldUploadNames && heldUploadNames.length > 0 ? (
        <p role="alert" className="mt-1 px-1.5 text-destructive text-xs">
          {heldUploadNames.length === 1
            ? t`${heldUploadNames[0]} didn't upload. Retry it or remove it, then send again.`
            : t`Some files didn't upload. Retry them or remove them, then send again.`}
        </p>
      ) : null}

      {/* Informational only — send stays live, matching the server's own
          quiet degrade (the image is dropped, the text reference stays).
          Warning tokens, not error ones: worth flagging, never blocks. */}
      {draftHasPictures && modelSupportsImageInput === false ? (
        <p
          role="status"
          className="mt-1.5 flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-bg px-2 py-1 text-warning-foreground text-xs"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
          {t`This model can't view pictures, so picture references are sent as text.`}
        </p>
      ) : null}

      <ComposerReferenceMenu id={MENU_ID} menu={menu} snapshot={snapshot} frameRef={frameRef} />

      <div className="mt-1 flex items-center gap-2">
        {toolbarLeft}

        <div className="flex-1" />

        <Button
          type="button"
          size="icon-sm"
          onClick={() => (streaming ? onStop?.() : void submit(runtime.current))}
          disabled={streaming ? false : !canSend}
          aria-label={streaming ? t`Stop` : t`Send message`}
          className={cn(
            "transition-all duration-200 ease-out",
            // Rounded square at rest (send) → circle while running (stop). Height
            // matches the toolbar's other controls (sm / 32px).
            streaming ? "rounded-full" : "rounded-field",
          )}
        >
          {streaming ? (
            <span className="size-2.5 rounded-[3px] bg-primary-foreground" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
});

const noSubscription = () => () => {};

/** Element-wise identity: ProseMirror keeps attrs objects stable for untouched nodes. */
function sameTokens(previous: ComposerUploadToken[], next: ComposerUploadToken[]): boolean {
  return previous.length === next.length && previous.every((token, index) => token === next[index]);
}

/** True when the menu took the key and the composer must not act on it. */
function menuKeyDown(
  menu: NonNullable<ReturnType<typeof getComposerReferenceMenu>>,
  event: KeyboardEvent,
): boolean {
  if (!menu.snapshot().open) return false;
  switch (event.key) {
    case "ArrowDown":
      return menu.move(1);
    case "ArrowUp":
      return menu.move(-1);
    case "Enter":
      // Shift+Enter is a hard break in the composer and stays one; a modifier
      // is the writer saying "send it", which the menu does not intercept.
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
      return menu.chooseActive();
    case "Escape":
      menu.dismiss();
      return true;
    default:
      return false;
  }
}

/**
 * Serializes the draft, sends it, clears, and keeps focus for a follow-up.
 *
 * Uploads shape two moments here (ratified decision 3): a submit during an
 * in-flight upload waits for it quietly — the draft stays editable, the
 * message goes the instant the last upload settles — and a failed upload
 * holds the send with a plain sentence until the writer retries or removes
 * it. The wait also guarantees every upload token carries its final
 * server-allocated spelling before the text serializes.
 */
async function submit(runtime: ComposerRuntime) {
  const editor = runtime.editor;
  if (!editor || editor.isDestroyed || runtime.sending) return;
  const attachments = runtime.attachments;

  if (
    attachments &&
    composerUploadTokens(editor.state.doc).some((token) => token.upload.state === "uploading")
  ) {
    runtime.sending = true;
    try {
      await attachments.settle();
    } finally {
      runtime.sending = false;
    }
    if (editor.isDestroyed) return;
  }

  const failedNames = composerUploadTokens(editor.state.doc)
    .filter((token) => token.upload.state === "failed")
    .map((token) => token.label);
  if (failedNames.length > 0) {
    runtime.holdSend(failedNames);
    return;
  }

  const text = serializeComposerText(editor.state.doc).trim();
  if (!text) return;
  // The trim never reaches a picture's URI (edge whitespace only), so the
  // server's every-image-URI-appears-in-text check holds by construction.
  const images = composerImageBlocks(editor.state.doc);
  // Everything in the draft is about to ride a turn: the clear below must
  // read as sent, never as detach-and-delete.
  attachments?.markSent(editor.state.doc);
  if (images.length > 0) runtime.onSubmit(text, [{ type: "text", text }, ...images]);
  else runtime.onSubmit(text);
  editor.chain().clearContent(true).focus().run();
}
