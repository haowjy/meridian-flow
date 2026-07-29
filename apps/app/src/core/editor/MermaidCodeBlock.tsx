/**
 * The mermaid fence's node view — the diagram the page shows instead of syntax.
 *
 * A `code_block` whose language is `mermaid` renders as a diagram and hides its
 * own `<pre>`; every other language is the fence itself (interaction model
 * §5.2). The three faces the render layer wears are `MermaidDiagramBody`; this
 * file owns the one choice above them, which is whether the writer is looking
 * at the diagram or at its source.
 *
 * ## The invariant
 *
 * **A selection inside the fence implies a visible, connected source content
 * DOM, and rendering that implication must not itself change the selection.**
 *
 * The first half is why the source comes back at all: a caret in a hidden
 * element eats every keystroke it is given. The second half is structural, and
 * it is what the DOM below is shaped by:
 *
 * - the content host is the wrapper's FIRST child and is never added, removed,
 *   or reordered — only its visibility changes;
 * - the render layer is one stable sibling AFTER it, so neither a face swap nor
 *   a parse settling moves DOM in front of ProseMirror's live selection.
 *
 * DOM appearing and vanishing ahead of a live selection is what made the two
 * faces alternate: the observer re-read the selection across the change, the
 * new reading fell outside the fence, the render came back, and the reading
 * fell inside again.
 *
 * The face is a one-way derivation of the current selection, with no memory and
 * no test of how the caret got there, so it converges after one render whatever
 * put it in — a keystroke, a command, a peer's write mapped through Yjs, a
 * pointer answered at a boundary. This file used to claim a pointer could not
 * produce that caret. It could. Where an outside press may land is
 * `pointer-boundary.ts`, and it is not what makes this file safe.
 */
import type { Editor, NodeViewProps } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import { useCallback, useSyncExternalStore } from "react";
import { MermaidDiagramBody } from "./MermaidDiagramBody";
import { useMermaidSvg } from "./mermaid-render-state";

/**
 * Is a live caret in this node's text, as opposed to standing on the node?
 *
 * Two things are deliberately not "inside":
 *
 * - a `NodeSelection` on the fence, which is how a writer picks a diagram up
 *   (law 1's click, or an arrow-walk), not how they edit its text;
 * - an unfocused editor, whose selection is only where the caret WOULD be. A
 *   document that opens on a diagram would otherwise show syntax until the
 *   writer clicked something, and no keystroke is at risk until focus is here.
 */
export function caretInsideNode(editor: Editor, pos: number | undefined): boolean {
  const node = pos === undefined ? null : editor.state.doc.nodeAt(pos);
  if (pos === undefined || !node || !editor.isFocused) return false;
  if (editor.state.selection instanceof NodeSelection) return false;
  const { from, to } = editor.state.selection;
  return from > pos && to < pos + node.nodeSize;
}

/**
 * `caretInsideNode`, subscribed and read fresh on every render.
 *
 * Not local state written from an effect: a face held in state is a second copy
 * of the answer, and a copy can disagree with the selection for a frame. The
 * subscription is deliberately coarse — every transaction, focus, and blur
 * re-reads, and React drops the readings that come back the same.
 */
function useCaretInsideNode(editor: Editor, getPos: () => number | undefined): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      editor.on("transaction", onStoreChange);
      editor.on("focus", onStoreChange);
      editor.on("blur", onStoreChange);
      return () => {
        editor.off("transaction", onStoreChange);
        editor.off("focus", onStoreChange);
        editor.off("blur", onStoreChange);
      };
    },
    [editor],
  );
  const read = () => caretInsideNode(editor, getPos());
  return useSyncExternalStore(subscribe, read, read);
}

export function MermaidCodeBlockNodeView(props: NodeViewProps) {
  const isMermaid = props.node.attrs.language === "mermaid";
  const source = props.node.textContent;
  const render = useMermaidSvg(isMermaid ? source : "");
  const caretInside = useCaretInsideNode(props.editor, props.getPos);
  const showSource = !isMermaid || caretInside;

  return (
    <NodeViewWrapper
      className={isMermaid ? "meridian-diagram-block" : undefined}
      data-language={String(props.node.attrs.language ?? "")}
    >
      {/* The content host. First child, unconditional, and never keyed off the
          selection: ProseMirror owns this text, and a node view that moved it
          would move the caret with it. `white-space: inherit` hands the wrap
          decision back to the `<pre>`, whose CSS the chip cluster's Wrap lines
          toggles; TipTap's own default (`pre-wrap`, inline) makes that control
          a no-op. */}
      <pre className={showSource ? undefined : "hidden"}>
        <NodeViewContent as={"code" as never} style={{ whiteSpace: "inherit" }} />
      </pre>
      {/* The render layer. Mounted for the whole life of a mermaid fence: the
          condition is the language attr, which only a document change moves, so
          no selection transition adds or removes this element. Everything
          inside it changes on the parser's clock instead. */}
      {isMermaid ? (
        <div className={showSource ? "hidden" : undefined} contentEditable={false}>
          <MermaidDiagramBody
            editor={props.editor}
            getPos={props.getPos}
            render={render}
            describesSource={render.rendered === source}
          />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
