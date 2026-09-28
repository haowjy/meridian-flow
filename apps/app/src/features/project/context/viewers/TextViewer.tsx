/** TextViewer — constrained read-only text preview for text and Markdown files. */
import { Trans } from "@lingui/react/macro";
import { type TextPreviewSource, useTextPreview } from "@/client/query/useTextPreview";
import { Markdown } from "@/rich-content/Markdown";

export function TextViewer({
  source,
  name,
  markdown,
  emptyMessage,
}: {
  source: TextPreviewSource;
  name: string;
  markdown?: boolean;
  emptyMessage?: React.ReactNode;
}) {
  const preview = useTextPreview(source);

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4">
      {preview.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Couldn't load this file.</Trans>
        </p>
      ) : preview.status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading preview…</Trans>
        </p>
      ) : preview.text.length === 0 && emptyMessage ? (
        <p className="text-sm leading-6 text-muted-foreground">{emptyMessage}</p>
      ) : markdown ? (
        <section aria-label={name}>
          <Markdown>{preview.text}</Markdown>
        </section>
      ) : (
        <section aria-label={name}>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
            {preview.text}
          </pre>
        </section>
      )}
    </div>
  );
}
