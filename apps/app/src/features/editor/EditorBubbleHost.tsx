/** Shared positioning, precedence, visibility, and focus host for editor bubbles. */
import { t } from "@lingui/core/macro";
import { type Editor, posToDOMRect } from "@tiptap/core";
import {
  createContext,
  type FC,
  forwardRef,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

export type BubbleMatch = {
  from: number;
  to: number;
  /** Position before the matched node. Required by node-top anchors. */
  nodePos?: number;
  data?: unknown;
};

export interface BubbleContext {
  id: string;
  /** Inspect selection/ancestors; null = inactive. Match carries node/mark pos + data. */
  match(editor: Editor): BubbleMatch | null;
  /** Where the bubble anchors: the selection rect (marks) or a node's edge (blocks). */
  anchor: "selection" | "node-top";
  Component: FC<{ editor: Editor; match: BubbleMatch }>;
}

export type EditorBubbleHostHandle = {
  open(id: string, options?: { focus?: boolean }): boolean;
  close(options?: { focusEditor?: boolean }): void;
};

type ActiveBubble = { context: BubbleContext; match: BubbleMatch };

const CONTEXT_PRIORITY = ["link", "code", "image", "table"] as const;
const priorityById = new Map<string, number>(CONTEXT_PRIORITY.map((id, index) => [id, index]));

export function selectBubbleContext(
  editor: Editor,
  contexts: readonly BubbleContext[],
): ActiveBubble | null {
  const ordered = contexts
    .map((context, registrationIndex) => ({ context, registrationIndex }))
    .sort(
      (a, b) =>
        (priorityById.get(a.context.id) ?? CONTEXT_PRIORITY.length) -
          (priorityById.get(b.context.id) ?? CONTEXT_PRIORITY.length) ||
        a.registrationIndex - b.registrationIndex,
    );

  for (const { context } of ordered) {
    const match = context.match(editor);
    if (match) return { context, match };
  }
  return null;
}

const BubbleActions = createContext<Pick<EditorBubbleHostHandle, "close"> | null>(null);

/** Lets bubble content dismiss itself without expanding the registration interface. */
export function useEditorBubble(): Pick<EditorBubbleHostHandle, "close"> {
  const value = useContext(BubbleActions);
  if (!value) throw new Error("useEditorBubble must be used inside EditorBubbleHost");
  return value;
}

export const EditorBubbleHost = forwardRef<
  EditorBubbleHostHandle,
  {
    editor: Editor | null;
    contexts: readonly BubbleContext[];
    contentId?: string;
    onActiveContextChange?: (id: string | null) => void;
  }
>(function EditorBubbleHost({ editor, contexts, contentId, onActiveContextChange }, forwardedRef) {
  const [version, setVersion] = useState(0);
  const [editorFocused, setEditorFocused] = useState(() => editor?.isFocused ?? false);
  const [bubbleFocused, setBubbleFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const active = useMemo(
    () => (editor && !editor.isDestroyed ? selectBubbleContext(editor, contexts) : null),
    [contexts, editor, version],
  );
  const signature = active ? bubbleSignature(active) : null;
  const dismissalKey = active && editor ? bubbleDismissalKey(active, editor) : null;
  const visible = Boolean(
    active &&
      !composing &&
      dismissalKey !== dismissedSignature &&
      (editorFocused || bubbleFocused || focusRequest === active.context.id),
  );

  const close = useCallback(
    (options?: { focusEditor?: boolean }) => {
      if (dismissalKey) setDismissedSignature(dismissalKey);
      setFocusRequest(null);
      if (options?.focusEditor && editor && !editor.isDestroyed) editor.commands.focus();
    },
    [dismissalKey, editor],
  );

  const open = useCallback(
    (id: string, options?: { focus?: boolean }) => {
      if (!editor || editor.isDestroyed) return false;
      const context = contexts.find((candidate) => candidate.id === id);
      const match = context?.match(editor);
      if (!context || !match) return false;
      setDismissedSignature(null);
      setFocusRequest(options?.focus ? id : null);
      return true;
    },
    [contexts, editor],
  );

  useImperativeHandle(forwardedRef, () => ({ open, close }), [close, open]);

  useEffect(() => {
    if (!editor) return;
    const bump = () => setVersion((value) => value + 1);
    const focus = () => setEditorFocused(true);
    const blur = () => {
      // A pointer press in portalled bubble content blurs ProseMirror before
      // the browser focuses the pressed control. Let that focus transition land.
      window.setTimeout(() => {
        setEditorFocused(editor.isFocused);
      });
    };
    editor.on("selectionUpdate", bump);
    editor.on("transaction", bump);
    editor.on("focus", focus);
    editor.on("blur", blur);
    return () => {
      editor.off("selectionUpdate", bump);
      editor.off("transaction", bump);
      editor.off("focus", focus);
      editor.off("blur", blur);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const startComposition = () => setComposing(true);
    const endComposition = () => {
      setComposing(false);
      setVersion((value) => value + 1);
    };
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      if (!open("link", { focus: true })) return;
      event.preventDefault();
    };
    dom.addEventListener("compositionstart", startComposition);
    dom.addEventListener("compositionend", endComposition);
    dom.addEventListener("keydown", shortcut);
    return () => {
      dom.removeEventListener("compositionstart", startComposition);
      dom.removeEventListener("compositionend", endComposition);
      dom.removeEventListener("keydown", shortcut);
    };
  }, [editor, open]);

  useEffect(() => {
    const trackBubbleFocus = () =>
      setBubbleFocused(bubbleRef.current?.contains(document.activeElement) ?? false);
    document.addEventListener("focusin", trackBubbleFocus);
    document.addEventListener("focusout", trackBubbleFocus);
    return () => {
      document.removeEventListener("focusin", trackBubbleFocus);
      document.removeEventListener("focusout", trackBubbleFocus);
    };
  }, []);

  useEffect(() => {
    onActiveContextChange?.(visible && active ? active.context.id : null);
  }, [active, onActiveContextChange, visible]);

  const focusBubble = useCallback(() => {
    if (!active || focusRequest !== active.context.id) return false;
    const target = bubbleRef.current?.querySelector<HTMLElement>("[data-bubble-autofocus]");
    if (!target) return false;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
    setFocusRequest(null);
    return true;
  }, [active, focusRequest]);

  useEffect(() => {
    if (!visible) return;
    let attempts = 0;
    let frame = 0;
    const tryFocus = () => {
      attempts += 1;
      if (!focusBubble() && attempts < 3) frame = window.requestAnimationFrame(tryFocus);
    };
    frame = window.requestAnimationFrame(tryFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [focusBubble, visible]);

  const anchorRef = useVirtualAnchor(editor, active);
  const Component = active?.context.Component;
  const actions = useMemo(() => ({ close }), [close]);

  return (
    <Popover
      open={visible}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        ref={bubbleRef}
        id={contentId}
        side="top"
        sideOffset={8}
        collisionPadding={8}
        updatePositionStrategy="always"
        className="w-auto p-0"
        aria-label={t`Editor contextual controls`}
        onPointerDownCapture={(event) => {
          setBubbleFocused(true);
          // Keep ProseMirror's selection live while a command button runs.
          // Text fields still take focus normally.
          if ((event.target as Element).closest("button, a")) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          close({ focusEditor: true });
        }}
      >
        <BubbleActions.Provider value={actions}>
          <div>
            {editor && active && Component ? (
              <Component key={signature} editor={editor} match={active.match} />
            ) : null}
          </div>
        </BubbleActions.Provider>
      </PopoverContent>
    </Popover>
  );
});

function bubbleSignature({ context, match }: ActiveBubble): string {
  return `${context.id}:${match.from}:${match.to}:${match.nodePos ?? ""}:${JSON.stringify(match.data)}`;
}

function bubbleDismissalKey({ context, match }: ActiveBubble, editor: Editor): string {
  const { from, to } = editor.state.selection;
  return `${context.id}:${from}:${to}:${match.nodePos ?? ""}`;
}

function useVirtualAnchor(
  editor: Editor | null,
  active: ActiveBubble | null,
): RefObject<{ getBoundingClientRect(): DOMRect }> {
  const editorRef = useRef(editor);
  const activeRef = useRef(active);
  editorRef.current = editor;
  activeRef.current = active;

  return useRef({
    getBoundingClientRect() {
      const currentEditor = editorRef.current;
      const current = activeRef.current;
      if (!currentEditor || currentEditor.isDestroyed || !current) return new DOMRect();
      if (current.context.anchor === "selection") {
        return posToDOMRect(currentEditor.view, current.match.from, current.match.to);
      }

      const node = currentEditor.view.nodeDOM(current.match.nodePos ?? current.match.from);
      if (!(node instanceof Element)) return new DOMRect();
      const rect = node.getBoundingClientRect();
      return new DOMRect(rect.x, rect.top, rect.width, 0);
    },
  });
}
