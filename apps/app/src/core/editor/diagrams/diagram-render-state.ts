import { t } from "@lingui/core/macro";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { DEFAULT_UI_THEME, resolveUiTheme, subscribeUiTheme } from "@/lib/ui-theme";

import type { DiagramProvider } from "./diagram-providers";
import { type SanitizedSvg, sanitizeSvg } from "./sanitized-svg";

const RENDER_DEBOUNCE_MS = 250;

export type DiagramRender = {
  svg: SanitizedSvg | null;
  error: string | null;
  rendered: string | null;
};

/**
 * Render `source` through `provider`.
 *
 * Every consumer gets its own id because a renderer writes it into the markup:
 * two faces of one diagram sharing an id would collide over the arrow markers
 * they reference by id, and the page's diagram would lose its arrowheads the
 * moment the dialog opened.
 */
export function useDiagramRender(provider: DiagramProvider, source: string): DiagramRender {
  const { language, render } = provider;
  const reactId = useId();
  const [result, setResult] = useState<DiagramRender>({ svg: null, error: null, rendered: null });
  // Renders resolve out of order under fast typing; only the newest may land.
  const generation = useRef(0);
  // A diagram is drawn in the manuscript's ink, so switching palettes has to
  // redraw it. A renderer bakes its colors into the markup; nothing about an
  // already-rendered SVG follows a token.
  const uiTheme = useSyncExternalStore(subscribeUiTheme, resolveUiTheme, () => DEFAULT_UI_THEME);

  useEffect(() => {
    const run = () => {
      generation.current += 1;
      const current = generation.current;
      const id = `meridian-${language}-${reactId.replaceAll(":", "")}-${current}`;

      void render(id, source)
        // The provider's output is raw markup until here. One sanitize per
        // landed render, on the way into state, so nothing downstream can be
        // handed the string the renderer actually returned.
        .then((markup) => {
          if (generation.current !== current) return;
          setResult({ svg: sanitizeSvg(markup), error: null, rendered: source });
        })
        .catch((error: unknown) => {
          if (generation.current !== current) return;
          const message = error instanceof Error ? error.message : t`Unable to render diagram`;
          setResult((previous) => ({ svg: previous.svg, error: message, rendered: source }));
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
  }, [language, render, reactId, source, uiTheme]);

  return result;
}

export type DiagramFace = "rendered" | "stale" | "unrendered" | "pending";

export function diagramFace({ svg, error }: DiagramRender): DiagramFace {
  if (svg) return error ? "stale" : "rendered";
  return error ? "unrendered" : "pending";
}
