/**
 * The mermaid fence's node view — the diagram the page shows instead of syntax.
 *
 * A `code_block` whose language is `mermaid` renders as a diagram and hides its
 * own `<pre>`; every other language is the fence itself (interaction model
 * §5.2). Source access belongs to the diagram dialog's ⋮, with two exceptions
 * this file owns: a fence that has never rendered shows itself so a broken
 * diagram is still reachable, and the source comes back whenever a caret is
 * inside it so no keystroke is ever swallowed by a hidden element.
 *
 * `useMermaidSvg` is the render pipeline both faces share. It keeps the LAST
 * GOOD svg across a failing edit (§5.2's "keeps the last good render and names
 * the line") — and naming the line is half the promise, so a stale render
 * carries the parse error beside it here as well as in the dialog's pane.
 */
import { t } from "@lingui/core/macro";
import type { Editor, NodeViewProps } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { DEFAULT_UI_THEME, resolveUiTheme, subscribeUiTheme } from "@/lib/ui-theme";

import { renderMermaid } from "./mermaid-render";

export type MermaidRender = {
  /**
   * The last source that rendered, markup and all. Stays non-null while
   * `error` is set: a broken edit keeps the previous diagram on screen rather
   * than blanking the canvas mid-keystroke.
   */
  svg: string | null;
  /** Mermaid's message for the current source, which usually names the line. */
  error: string | null;
  /** No render has completed yet, for any source. */
  pending: boolean;
};

/**
 * Render `source` to SVG.
 *
 * Every consumer gets its own id because mermaid writes it into the markup:
 * two faces of one diagram sharing an id would collide over the arrow markers
 * they reference by id, and the page's diagram would lose its arrowheads the
 * moment the dialog opened.
 */
export function useMermaidSvg(source: string): MermaidRender {
  const reactId = useId();
  const [render, setRender] = useState<MermaidRender>({ svg: null, error: null, pending: true });
  // Renders resolve out of order under fast typing; only the newest may land.
  const generation = useRef(0);
  // A diagram is drawn in the manuscript's ink, so switching palettes has to
  // redraw it. Mermaid bakes its colors into the markup; nothing about an
  // already-rendered SVG follows a token.
  const uiTheme = useSyncExternalStore(subscribeUiTheme, resolveUiTheme, () => DEFAULT_UI_THEME);

  useEffect(() => {
    generation.current += 1;
    const current = generation.current;
    const id = `meridian-mermaid-${reactId.replaceAll(":", "")}-${current}`;

    void renderMermaid(id, source)
      .then((svg) => {
        if (generation.current === current) setRender({ svg, error: null, pending: false });
      })
      .catch((error: unknown) => {
        if (generation.current !== current) return;
        const message = error instanceof Error ? error.message : t`Unable to render diagram`;
        setRender((previous) => ({ svg: previous.svg, error: message, pending: false }));
      });
  }, [reactId, source, uiTheme]);

  return render;
}

/**
 * Is a live caret in this node's text, as opposed to standing on the node?
 *
 * The diagram stands in for its own source, so the source has to come back the
 * moment a caret is in it — otherwise keystrokes land in a hidden element and
 * vanish. Two things are deliberately not "inside":
 *
 * - a `NodeSelection` on the fence, which is how a writer picks a diagram up
 *   (law 1's click, or an arrow-walk), not how they edit its text;
 * - an unfocused editor, whose selection is only where the caret WOULD be. A
 *   document that opens on a diagram would otherwise show syntax until the
 *   writer clicked something, and no keystroke is at risk until focus is here.
 */
function useCaretInsideNode(editor: Editor, getPos: () => number | undefined): boolean {
  const [inside, setInside] = useState(false);

  useEffect(() => {
    const read = () => {
      const pos = getPos();
      const node = pos === undefined ? null : editor.state.doc.nodeAt(pos);
      if (
        pos === undefined ||
        !node ||
        !editor.isFocused ||
        editor.state.selection instanceof NodeSelection
      ) {
        setInside(false);
        return;
      }
      const { from, to } = editor.state.selection;
      setInside(from > pos && to < pos + node.nodeSize);
    };

    read();
    editor.on("selectionUpdate", read);
    editor.on("transaction", read);
    editor.on("focus", read);
    editor.on("blur", read);
    return () => {
      editor.off("selectionUpdate", read);
      editor.off("transaction", read);
      editor.off("focus", read);
      editor.off("blur", read);
    };
  }, [editor, getPos]);

  return inside;
}

export function MermaidCodeBlockNodeView(props: NodeViewProps) {
  const isMermaid = props.node.attrs.language === "mermaid";
  const source = props.node.textContent;
  const { svg, error, pending } = useMermaidSvg(isMermaid ? source : "");
  const caretInside = useCaretInsideNode(props.editor, props.getPos);

  const showDiagram = isMermaid && svg !== null && !caretInside;
  const showFence = !isMermaid || caretInside || (error !== null && svg === null);
  // A render that no longer matches its source. The picture stays — it is
  // still the truest thing on the page about this diagram — but a failure the
  // writer cannot see is one they cannot fix (law 5).
  const renderIsStale = isMermaid && error !== null && svg !== null;

  return (
    <NodeViewWrapper
      className={isMermaid ? "meridian-diagram-block" : undefined}
      data-language={String(props.node.attrs.language ?? "")}
    >
      {isMermaid && error && svg === null ? (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-3 text-destructive text-sm"
          contentEditable={false}
          role="alert"
        >
          <p className="font-medium">{t`Diagram could not be rendered`}</p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{error}</p>
        </div>
      ) : null}
      {renderIsStale ? (
        <p className="meridian-diagram-parse-note mb-2" contentEditable={false} role="status">
          {t`This diagram stopped parsing. Showing the last version that rendered.`}
          <code>{error}</code>
        </p>
      ) : null}
      {isMermaid && pending && !caretInside ? (
        <div
          className="px-4 py-6 text-center text-muted-foreground text-sm"
          contentEditable={false}
          role="status"
        >
          {t`Rendering diagram…`}
        </div>
      ) : null}
      {/* The fence stays in the tree either way: ProseMirror owns this text,
          and a node view that dropped its content DOM would drop the writer's
          edits with it. Hidden while the diagram stands in for it. */}
      <pre className={showFence ? undefined : "hidden"}>
        {/* `white-space: inherit` hands the decision back to the `<pre>`, whose
            CSS the chip cluster's Wrap lines toggles. TipTap's own default
            (`pre-wrap`, inline) would make that control a no-op. */}
        <NodeViewContent as={"code" as never} style={{ whiteSpace: "inherit" }} />
      </pre>
      {showDiagram ? (
        <div
          className="meridian-diagram"
          contentEditable={false}
          data-mermaid-preview=""
          // Mermaid's strict security mode sanitizes authored labels before producing the SVG.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}
