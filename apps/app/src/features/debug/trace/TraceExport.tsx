/** JSONL export controls for the dev-only viewer; inline English is intentional. */
import type { EventRecord } from "@meridian/contracts/observability";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

function toJsonl(entries: readonly EventRecord[]): string {
  return entries.map((record) => JSON.stringify(record)).join("\n");
}

export function TraceExport({ entries }: { entries: readonly EventRecord[] }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const jsonl = useMemo(() => toJsonl(entries), [entries]);

  async function copy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(jsonl);
    setCopied(true);
  }

  function download() {
    if (typeof document === "undefined" || typeof URL === "undefined") return;
    const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "meridian-trace.jsonl";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="border-t border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <span className="text-meta text-muted-foreground">Filtered JSONL · {entries.length}</span>
        <Button type="button" variant="outline" size="xs" className="text-meta" onClick={copy}>
          {copied ? "Copied" : "Copy"}
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
