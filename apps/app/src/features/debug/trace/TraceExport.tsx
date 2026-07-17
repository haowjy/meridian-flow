/** JSONL export controls for the dev-only viewer; inline English is intentional. */
import type { EventRecord } from "@meridian/contracts/observability";
import { type MouseEvent, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

function toJsonl(entries: readonly EventRecord[]): string {
  return entries.map((record) => JSON.stringify(record)).join("\n");
}

export function TraceExport({ entries }: { entries: readonly EventRecord[] }) {
  const [show, setShow] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const jsonl = useMemo(() => toJsonl(entries), [entries]);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const clipboard = event.currentTarget.ownerDocument.defaultView?.navigator.clipboard;
    if (!clipboard) {
      setCopyStatus("failed");
      return;
    }

    try {
      await clipboard.writeText(jsonl);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  function download(event: MouseEvent<HTMLButtonElement>) {
    const ownerDocument = event.currentTarget.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return;

    const url = ownerWindow.URL.createObjectURL(
      new ownerWindow.Blob([jsonl], { type: "application/x-ndjson" }),
    );
    const anchor = ownerDocument.createElement("a");
    anchor.href = url;
    anchor.download = "meridian-trace.jsonl";
    ownerDocument.body.append(anchor);
    anchor.click();
    anchor.remove();
    ownerWindow.URL.revokeObjectURL(url);
  }

  return (
    <div className="border-t border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <span className="text-meta text-muted-foreground">Filtered JSONL · {entries.length}</span>
        <Button type="button" variant="outline" size="xs" className="text-meta" onClick={copy}>
          {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}
        </Button>
        <Button type="button" variant="outline" size="xs" className="text-meta" onClick={download}>
          Download
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="text-meta"
          onClick={() => setShow((current) => !current)}
          aria-expanded={show}
        >
          {show ? "Hide readable export" : "Show readable export"}
        </Button>
      </div>
      {show ? (
        <section aria-label="Filtered trace JSONL export">
          <pre
            role="document"
            aria-label={jsonl || "Empty filtered trace JSONL"}
            data-trace-jsonl-export
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-muted p-2 font-mono text-meta text-foreground"
          >
            {jsonl}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
