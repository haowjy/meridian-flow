/**
 * What mermaid has made of a diagram's source so far.
 *
 * The async parser's state and nothing else. Render status changes when a
 * parse settles; which face a node view wears changes when the selection
 * moves. They are separate clocks, and keeping them apart is what makes the
 * node view's one invariant checkable — see `MermaidCodeBlock.tsx`.
 */
import { t } from "@lingui/core/macro";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { DEFAULT_UI_THEME, resolveUiTheme, subscribeUiTheme } from "@/lib/ui-theme";

import { renderMermaid } from "./mermaid-render";

/**
 * How long source rests before it is parsed again.
 *
 * Mermaid reparses and re-lays-out the whole diagram per render, so a fence
 * being typed into would run one full parse per keystroke and throw all but the
 * last away. The pause costs nothing visible: the last good render stays on
 * screen throughout. It is a render cost, never a face timer — no face waits
 * on it.
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

/** Which of §5.2's faces the diagram is wearing right now. */
export type DiagramFace =
  /** A render that matches its source. */
  | "rendered"
  /** The last good render, kept while the current source does not parse. */
  | "stale"
  /** Source that has never parsed: there is no picture to keep. */
  | "unrendered"
  /** Nothing has been parsed yet. */
  | "pending";

export function diagramFace({ svg, error }: MermaidRender): DiagramFace {
  if (svg) return error ? "stale" : "rendered";
  return error ? "unrendered" : "pending";
}
