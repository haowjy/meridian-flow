/** TextViewer — constrained read-only text preview for text and Markdown files. */
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

export function TextViewer({
  url,
  name,
  content,
}: {
  url?: string;
  name: string;
  content?: string;
}) {
  const [text, setText] = useState<string | null>(content ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (content !== undefined) {
      setText(content);
      setFailed(false);
      return;
    }
    if (!url) return;
    const controller = new AbortController();
    setText(null);
    setFailed(false);
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Text preview request failed");
        return response.text();
      })
      .then(setText)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, [content, url]);

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4">
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Couldn't load this file.</Trans>
        </p>
      ) : text === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading preview…</Trans>
        </p>
      ) : (
        <section aria-label={name}>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
            {text}
          </pre>
        </section>
      )}
    </div>
  );
}
