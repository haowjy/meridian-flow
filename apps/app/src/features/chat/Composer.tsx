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
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { ArrowUp } from "lucide-react";
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

import { Button } from "@/components/ui/button";
import type { ReferenceCatalog } from "@/core/references";
import { useReferenceCandidates } from "@/features/project/context/useReferenceCandidates";
import { cn } from "@/lib/utils";

import {
  ComposerReferenceMenu,
  closedComposerReferenceMenu,
  createComposerExtensions,
  getComposerReferenceMenu,
  serializeComposerText,
} from "./composer-input";
import "./composer-input/composer-input.css";
import { useComposerPlaceholder } from "./placeholders";

export type ComposerProps = {
  /** Called with the trimmed message text when the user submits a non-empty draft. */
  onSubmit: (text: string) => void;
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
  onSubmit: (text: string) => void;
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
  },
  ref,
) {
  const rotatingPlaceholder = useComposerPlaceholder(streaming);
  const resolvedPlaceholder = placeholder ?? rotatingPlaceholder;
  const { candidates } = useReferenceCandidates({ projectId, workId });
  const frameRef = useRef<HTMLDivElement>(null);
  const [canSend, setCanSend] = useState(false);

  // The editor's callbacks are created once and live for the mount; this ref
  // is how they read the render they are actually running in.
  const runtime = useRef<ComposerRuntime>({
    editor: null,
    catalog: null,
    placeholder: "",
    streaming: false,
    onSubmit,
    onStop,
  });
  // With no project there is nothing internal to name, so `@` in the Home
  // hero is ordinary prose: a null catalog keeps the trigger silent.
  runtime.current.catalog = projectId ? { label: t`Reference a document`, candidates } : null;
  runtime.current.placeholder = resolvedPlaceholder;
  runtime.current.streaming = streaming;
  runtime.current.onSubmit = onSubmit;
  runtime.current.onStop = onStop;

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
              if (!current.streaming) submit(current);
              return true;
            }
            // Shift+Enter falls through to the hard-break keymap.
          }
          return false;
        },
      },
      onCreate: ({ editor: created }) => {
        runtime.current.editor = created;
      },
      onUpdate: ({ editor: updated }) => {
        setCanSend(serializeComposerText(updated.state.doc).trim().length > 0);
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
      <EditorContent
        editor={editor}
        className={cn("composer-editor", variant === "hero" ? "min-h-[52px]" : "min-h-[40px]")}
      />

      <ComposerReferenceMenu id={MENU_ID} menu={menu} snapshot={snapshot} frameRef={frameRef} />

      <div className="mt-1 flex items-center gap-2">
        {toolbarLeft}

        <div className="flex-1" />

        <Button
          type="button"
          size="icon-sm"
          onClick={() => (streaming ? onStop?.() : submit(runtime.current))}
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

/** Serializes the draft, sends it, clears, and keeps focus for a follow-up. */
function submit(runtime: ComposerRuntime) {
  const editor = runtime.editor;
  if (!editor || editor.isDestroyed) return;
  const text = serializeComposerText(editor.state.doc).trim();
  if (!text) return;
  runtime.onSubmit(text);
  editor.chain().clearContent(true).focus().run();
}
