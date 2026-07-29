/**
 * The render layer's three faces (interaction model §5.2).
 *
 * "The page never shows a diagram's syntax" is that section's rule, so a diagram
 * standing in for its own source has three ways to look and none of them is a
 * code block:
 *
 * 1. the render, whenever there is one;
 * 2. the LAST GOOD render plus the parse error, once an edit stops parsing;
 * 3. an error card naming the problem, for source that has never rendered at
 *    all — with Edit source as its one door, the same door Enter and a
 *    double-click open.
 *
 * Provider-neutral: every diagram kind wears the same three faces, and only the
 * markup inside them and the provider's name differ. Everything here changes on
 * the parser's clock, never the selection's; the node view keeps it behind a
 * stable host for exactly that reason.
 *
 * Presentation only. The door out is a callback rather than an engagement this
 * file resolves, so the diagrams module stays free of object physics and the
 * surface that owns the source pane stays the one that opens it.
 */
import { t } from "@lingui/core/macro";
import { Code2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { type DiagramRender, diagramFace } from "./diagram-render-state";

/**
 * Finds the element holding the rendered markup, for the verbs that export the
 * picture the writer is looking at (`surfaces/objects/object-commands.ts`).
 * Every provider's render lands inside `data-diagram-preview` below, so nothing
 * downstream needs to know which provider drew it.
 */
export const DIAGRAM_PREVIEW_SELECTOR = "[data-diagram-preview]";

export function DiagramBody({
  render,
  describesSource,
  onEditSource,
}: {
  render: DiagramRender;
  /**
   * False once the writer has changed the source the render describes. A note
   * about text they have already replaced is noise: the next render is moments
   * away and will speak for what is on screen.
   */
  describesSource: boolean;
  /** Opens the source the writer has to fix. The one door on the error card. */
  onEditSource: () => void;
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
    return <DiagramErrorCard message={render.error} onEditSource={onEditSource} />;
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
        data-diagram-preview=""
        // A provider sanitizes authored labels before producing the SVG.
        dangerouslySetInnerHTML={{ __html: render.svg ?? "" }}
      />
    </>
  );
}

/**
 * Source that has never parsed, said plainly, with its one way out.
 *
 * There is no picture to keep here, and §5.2's "the page never shows a diagram's
 * syntax" holds even when the syntax is the problem: a fence spilled into the
 * chapter as raw code reads as the manuscript itself having broken, and it wears
 * a diagram's hover controls over a wall of text. The card says what the
 * renderer said, verbatim, and hands the writer the same source pane Enter and a
 * double-click open.
 */
function DiagramErrorCard({
  message,
  onEditSource,
}: {
  message: string | null;
  onEditSource: () => void;
}) {
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
          onClick={onEditSource}
        >
          <Code2 aria-hidden />
          {t`Edit source`}
        </Button>
      </div>
      {message ? <code className="meridian-diagram-error-message">{message}</code> : null}
    </div>
  );
}
