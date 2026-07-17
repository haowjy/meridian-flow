/** Shared positioning, precedence, visibility, and focus host for editor bubbles. */
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
  /** Logical feature-owned identity; unlike positions, this survives document mapping. */
  identity: unknown;
  /** Position before the matched node. Required by node-top anchors. */
  nodePos?: number;
  data?: unknown;
};

export type BubbleShortcut = {
  key: string;
  primaryModifier?: boolean;
  altKey?: boolean;
};

export type BubbleEntry = {
  match(editor: Editor): BubbleMatch | null;
  shortcut?: BubbleShortcut;
};

export interface BubbleContext {
  id: string;
  /** Inspect selection/ancestors; null = inactive. Match carries node/mark pos + data. */
  match(editor: Editor): BubbleMatch | null;
  /** Where the bubble anchors: the selection rect (marks) or a node's edge (blocks). */
  anchor: "selection" | "node-top";
  /** Context-specific dialog name, resolved at render time for the active locale. */
  accessibleName(): string;
  /** Optional explicit-entry policy, separate from passive arbitration. */
  entry?: BubbleEntry;
  Component: FC<{ editor: Editor; match: BubbleMatch }>;
}

export type EditorBubbleHostHandle = {
  open(id: string, options?: { focus?: boolean }): boolean;
  close(options?: { focusEditor?: boolean }): void;
};

type ActiveBubble = { context: BubbleContext; match: BubbleMatch };

export function selectBubbleContext(
  editor: Editor,
  contexts: readonly BubbleContext[],
): ActiveBubble | null {
  for (const context of contexts) {
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
  const [dismissed, setDismissed] = useState<Pick<ActiveBubble, "context" | "match"> | null>(null);
  const [entered, setEntered] = useState<{ contextId: string; identity: object } | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => {
    if (!editor || editor.isDestroyed) return null;
    if (entered) {
      const context = contexts.find((candidate) => candidate.id === entered.contextId);
      const match = context?.entry?.match(editor);
      if (context && match) {
        return { context, match: { ...match, identity: entered.identity } };
      }
    }
    return selectBubbleContext(editor, contexts);
  }, [contexts, editor, entered, version]);
  const componentKey = useBubbleComponentKey(active);
  const isDismissed = Boolean(
    active &&
      dismissed?.context.id === active.context.id &&
      Object.is(dismissed.match.identity, active.match.identity),
  );
  const visible = Boolean(
    active &&
      !composing &&
      !isDismissed &&
      (editorFocused || bubbleFocused || focusRequest === active.context.id),
  );

  const close = useCallback(
    (options?: { focusEditor?: boolean }) => {
      if (active) setDismissed(active);
      setEntered(null);
      setFocusRequest(null);
      if (options?.focusEditor && editor && !editor.isDestroyed) editor.commands.focus();
    },
    [active, editor],
  );

  const open = useCallback(
    (id: string, options?: { focus?: boolean }) => {
      if (!editor || editor.isDestroyed) return false;
      const context = contexts.find((candidate) => candidate.id === id);
      const match = context?.entry?.match(editor) ?? context?.match(editor);
      if (!context || !match) return false;
      setDismissed(null);
      setEntered({ contextId: id, identity: {} });
      setFocusRequest(options?.focus ? id : null);
      return true;
    },
    [contexts, editor],
  );

  useImperativeHandle(forwardedRef, () => ({ open, close }), [close, open]);

  useEffect(() => {
    if (!editor) return;
    const bump = () => setVersion((value) => value + 1);
    const selection = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) setEntered(null);
      bump();
    };
    const focus = () => setEditorFocused(true);
    const blur = () => {
      // A pointer press in portalled bubble content blurs ProseMirror before
      // the browser focuses the pressed control. Let that focus transition land.
      window.setTimeout(() => {
        setEditorFocused(editor.isFocused);
      });
    };
    editor.on("selectionUpdate", selection);
    editor.on("transaction", bump);
    editor.on("focus", focus);
    editor.on("blur", blur);
    return () => {
      editor.off("selectionUpdate", selection);
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
      const context = contexts.find(
        (candidate) =>
          candidate.entry?.shortcut && shortcutMatches(event, candidate.entry.shortcut),
      );
      if (!context || !open(context.id, { focus: true })) return;
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
  }, [contexts, editor, open]);

  useEffect(() => {
    if (
      !active ||
      (dismissed &&
        (dismissed.context.id !== active.context.id ||
          !Object.is(dismissed.match.identity, active.match.identity)))
    ) {
      setDismissed(null);
    }
  }, [active, dismissed]);

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
        aria-label={active?.context.accessibleName()}
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
              <Component key={componentKey} editor={editor} match={active.match} />
            ) : null}
          </div>
        </BubbleActions.Provider>
      </PopoverContent>
    </Popover>
  );
});

function useBubbleComponentKey(active: ActiveBubble | null): number {
  const sequence = useRef(0);
  const previous = useRef<{ contextId: string; identity: unknown; key: number } | null>(null);
  if (!active) {
    previous.current = null;
    return sequence.current;
  }
  if (
    !previous.current ||
    previous.current.contextId !== active.context.id ||
    !Object.is(previous.current.identity, active.match.identity)
  ) {
    previous.current = {
      contextId: active.context.id,
      identity: active.match.identity,
      key: ++sequence.current,
    };
  }
  return previous.current.key;
}

function shortcutMatches(event: KeyboardEvent, shortcut: BubbleShortcut): boolean {
  return (
    event.key.toLowerCase() === shortcut.key.toLowerCase() &&
    (!shortcut.primaryModifier || event.metaKey || event.ctrlKey) &&
    event.altKey === (shortcut.altKey ?? false)
  );
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
