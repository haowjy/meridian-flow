/**
 * The mermaid fence's node view — the diagram the page shows instead of syntax.
 *
 * A `code_block` whose language is `mermaid` renders as a diagram and hides its
 * own `<pre>`; every other language is the fence itself (interaction model
 * §5.2). "The page never shows Mermaid syntax" is that section's rule, so a
 * diagram has three faces and none of them is a code block:
 *
 * 1. the render, whenever there is one;
 * 2. the LAST GOOD render plus the parse error, once an edit stops parsing;
 * 3. an error card naming the problem, for source that has never rendered at
 *    all — with Edit source as its one door, the same door Enter and a
 *    double-click open.
 *
 * The single exception the file owns is a caret INSIDE the fence: a fence typed
 * as markdown is filled in by hand, and a caret in a hidden element eats every
 * keystroke it is given. That face is the writer's own doing — never a
 * pointer's, which is what `useCaretInsideNode` is careful about.
 */
import { t } from "@lingui/core/macro";
import type { Editor, NodeViewProps } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { NodeSelection } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import { Code2 } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { DEFAULT_UI_THEME, resolveUiTheme, subscribeUiTheme } from "@/lib/ui-theme";

import { renderMermaid } from "./mermaid-render";
import { engageObject, selectObjectTransaction } from "./objects";

/**
 * How long source rests before it is parsed again.
 *
 * Mermaid reparses and re-lays-out the whole diagram per render, so a fence
 * being typed into would run one full parse per keystroke and throw all but the
 * last away. The pause costs nothing visible: the last good render stays on
 * screen throughout.
 */
const RENDER_DEBOUNCE_MS = 250;

export type MermaidRender = {
  /**
   * The last source that rendered, markup and all. Stays non-null while
   * `error` is set: a broken edit keeps the previous diagram on screen rather
   * than blanking the canvas mid-keystroke.
   */
  svg: string | null;
  /** Mermaid's message for `rendered`, which usually names the line. */
  error: string | null;
  /**
   * The source `svg` and `error` describe. Null until the first render
   * settles, which is how "nothing has been parsed yet" is said without a
   * second flag that could disagree with this one.
   */
  rendered: string | null;
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
  const [render, setRender] = useState<MermaidRender>({ svg: null, error: null, rendered: null });
  // Renders resolve out of order under fast typing; only the newest may land.
  const generation = useRef(0);
  // A diagram is drawn in the manuscript's ink, so switching palettes has to
  // redraw it. Mermaid bakes its colors into the markup; nothing about an
  // already-rendered SVG follows a token.
  const uiTheme = useSyncExternalStore(subscribeUiTheme, resolveUiTheme, () => DEFAULT_UI_THEME);

  useEffect(() => {
    const run = () => {
      generation.current += 1;
      const current = generation.current;
      const id = `meridian-mermaid-${reactId.replaceAll(":", "")}-${current}`;

      void renderMermaid(id, source)
        .then((svg) => {
          if (generation.current === current) setRender({ svg, error: null, rendered: source });
        })
        .catch((error: unknown) => {
          if (generation.current !== current) return;
          const message = error instanceof Error ? error.message : t`Unable to render diagram`;
          setRender((previous) => ({ svg: previous.svg, error: message, rendered: source }));
        });
    };

    // The first parse is not a pause in typing, it is a chapter opening, and
    // every diagram in it would otherwise sit blank for the length of a pause
    // nobody took.
    if (generation.current === 0) {
      run();
      return;
    }

    const timer = window.setTimeout(run, RENDER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
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

    // `transaction` alone: `selectionUpdate` is a subset of it, and a
    // transaction that moved neither the document nor the selection cannot
    // have moved the caret. Focus and blur move no transaction at all, and are
    // the other half of the answer.
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged || transaction.selectionSet) read();
    };

    read();
    editor.on("transaction", onTransaction);
    editor.on("focus", read);
    editor.on("blur", read);
    return () => {
      editor.off("transaction", onTransaction);
      editor.off("focus", read);
      editor.off("blur", read);
    };
  }, [editor, getPos]);

  return inside;
}

/** Which of §5.2's faces the diagram is wearing right now. */
type DiagramFace =
  /** A render that matches its source. */
  | "rendered"
  /** The last good render, kept while the current source does not parse. */
  | "stale"
  /** Source that has never parsed: there is no picture to keep. */
  | "unrendered"
  /** Nothing has been parsed yet. */
  | "pending";

function diagramFace({ svg, error }: MermaidRender): DiagramFace {
  if (svg) return error ? "stale" : "rendered";
  return error ? "unrendered" : "pending";
}

export function MermaidCodeBlockNodeView(props: NodeViewProps) {
  const isMermaid = props.node.attrs.language === "mermaid";
  const source = props.node.textContent;
  const render = useMermaidSvg(isMermaid ? source : "");
  const caretInside = useCaretInsideNode(props.editor, props.getPos);
  const showFence = !isMermaid || caretInside;

  return (
    <NodeViewWrapper
      className={isMermaid ? "meridian-diagram-block" : undefined}
      data-language={String(props.node.attrs.language ?? "")}
    >
      {showFence ? null : (
        <DiagramBody
          editor={props.editor}
          getPos={props.getPos}
          render={render}
          // A note about source the writer has already changed is noise: the
          // next render is moments away and will speak for the text on screen.
          describesSource={render.rendered === source}
        />
      )}
      {/* The fence stays in the tree either way: ProseMirror owns this text,
          and a node view that dropped its content DOM would drop the writer's
          edits with it. Hidden while the diagram stands in for it. */}
      <pre className={showFence ? undefined : "hidden"}>
        {/* `white-space: inherit` hands the decision back to the `<pre>`, whose
            CSS the chip cluster's Wrap lines toggles. TipTap's own default
            (`pre-wrap`, inline) would make that control a no-op. */}
        <NodeViewContent as={"code" as never} style={{ whiteSpace: "inherit" }} />
      </pre>
    </NodeViewWrapper>
  );
}

function DiagramBody({
  editor,
  getPos,
  render,
  describesSource,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  render: MermaidRender;
  describesSource: boolean;
}) {
  const face = diagramFace(render);

  if (face === "pending") {
    return (
      <div
        className="px-4 py-6 text-center text-muted-foreground text-sm"
        contentEditable={false}
        role="status"
      >
        {t`Rendering diagram…`}
      </div>
    );
  }

  if (face === "unrendered") {
    return <DiagramErrorCard editor={editor} getPos={getPos} message={render.error} />;
  }

  return (
    <>
      {/* A render that no longer matches its source. The picture stays — it is
          still the truest thing on the page about this diagram — but a failure
          the writer cannot see is one they cannot fix (law 5). */}
      {face === "stale" && describesSource ? (
        <p className="meridian-diagram-parse-note mb-2" contentEditable={false} role="status">
          {t`This diagram stopped parsing. Showing the last version that rendered.`}
          <code>{render.error}</code>
        </p>
      ) : null}
      <div
        className="meridian-diagram"
        contentEditable={false}
        data-mermaid-preview=""
        // Mermaid's strict security mode sanitizes authored labels before producing the SVG.
        dangerouslySetInnerHTML={{ __html: render.svg ?? "" }}
      />
    </>
  );
}

/**
 * Source that has never parsed, said plainly, with its one way out.
 *
 * There is no picture to keep here, and §5.2's "the page never shows Mermaid
 * syntax" holds even when the syntax is the problem: a fence spilled into the
 * chapter as raw code reads as the manuscript itself having broken, and it
 * wears a diagram's hover controls over a wall of text. The card says what
 * mermaid said, verbatim, and hands the writer the same source pane Enter and
 * a double-click open.
 */
function DiagramErrorCard({
  editor,
  getPos,
  message,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  message: string | null;
}) {
  const openSource = () => {
    const pos = getPos();
    const node = pos === undefined ? null : editor.state.doc.nodeAt(pos);
    if (pos === undefined || !node) return;
    // Select first: engaging leaves the diagram selected underneath, so
    // closing the dialog lands on it rather than wherever the caret was.
    const selected = selectObjectTransaction(editor.state, pos);
    if (selected) editor.view.dispatch(selected);
    engageObject(editor, { node, pos }, "engage");
  };

  return (
    <div className="meridian-diagram-error" contentEditable={false} role="status">
      <div className="meridian-diagram-error-head">
        <p className="meridian-diagram-error-title">{t`This diagram has a syntax problem`}</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          // A press here must not carry a caret into the fence underneath.
          onMouseDown={(event) => event.preventDefault()}
          onClick={openSource}
        >
          <Code2 aria-hidden />
          {t`Edit source`}
        </Button>
      </div>
      {message ? <code className="meridian-diagram-error-message">{message}</code> : null}
    </div>
  );
}
