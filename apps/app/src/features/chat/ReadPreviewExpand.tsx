/**
 * ReadPreviewExpand — inline disclosure body for a read row.
 *
 * Renders read-tool output as read-only ProseMirror HTML so headings, emphasis,
 * lists, and tables inherit the editor typography instead of showing raw
 * markdown. DOM serialization runs in an effect because it needs `document`, so
 * SSR paints the bounded shell and the client fills it after mount. Unparseable
 * reads fall back to stripped plain text.
 */
import "@/features/editor/editor.css";
import { useEffect, useRef, useState } from "react";
import { renderReadFragment, stripReadHashes } from "./read-preview-render";

type ReadPreviewExpandProps = {
  content: string;
};

export function ReadPreviewExpand({ content }: ReadPreviewExpandProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [plainFallback, setPlainFallback] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      const fragment = renderReadFragment(content);
      if (fragment && fragment.childNodes.length > 0) {
        host.replaceChildren(fragment);
        setPlainFallback(null);
        return;
      }
    } catch {
      // Outlines and other non-manuscript reads can fail the manuscript schema;
      // keep the row useful by showing the readable, de-prefixed text instead.
    }
    host.replaceChildren();
    setPlainFallback(stripReadHashes(content).trim());
  }, [content]);

  return (
    <div className="meridian-editor max-h-72 max-w-full overflow-auto rounded-md border border-border-subtle bg-card px-3.5 py-2.5 overscroll-contain">
      {plainFallback != null ? (
        <div className="text-compact whitespace-pre-wrap break-words text-ink-muted">
          {plainFallback}
        </div>
      ) : (
        <div ref={hostRef} className="ProseMirror min-w-0 max-w-full [zoom:0.85]" />
      )}
    </div>
  );
}
