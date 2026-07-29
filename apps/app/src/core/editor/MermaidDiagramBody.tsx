/**
 * The render layer's three faces (interaction model §5.2).
 *
 * "The page never shows Mermaid syntax" is that section's rule, so a diagram
 * standing in for its own source has three ways to look and none of them is a
 * code block:
 *
 * 1. the render, whenever there is one;
 * 2. the LAST GOOD render plus the parse error, once an edit stops parsing;
 * 3. an error card naming the problem, for source that has never rendered at
 *    all — with Edit source as its one door, the same door Enter and a
 *    double-click open.
 *
 * Everything here changes on the parser's clock, never the selection's. The
 * node view keeps it behind a stable host for exactly that reason.
 */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Code2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { diagramFace, type MermaidRender } from "./mermaid-render-state";
import { engageObject, selectObjectTransaction } from "./objects";

export function MermaidDiagramBody({
  editor,
  getPos,
  render,
  describesSource,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  render: MermaidRender;
  /**
   * False once the writer has changed the source the render describes. A note
   * about text they have already replaced is noise: the next render is moments
   * away and will speak for what is on screen.
   */
  describesSource: boolean;
}) {
  const face = diagramFace(render);

  if (face === "pending") {
    return (
      <div className="px-4 py-6 text-center text-muted-foreground text-sm" role="status">
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
        <p className="meridian-diagram-parse-note mb-2" role="status">
          {t`This diagram stopped parsing. Showing the last version that rendered.`}
          <code>{render.error}</code>
        </p>
      ) : null}
      <div
        className="meridian-diagram"
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
    <div className="meridian-diagram-error" role="status">
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
