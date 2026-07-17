/** JSONL export controls for the dev-only viewer; inline English is intentional. */
import type { EventRecord } from "@meridian/contracts/observability";
import { useMemo, useState } from "react";

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

  const buttonClass =
    "focus-ring rounded border border-border px-2 py-1 text-meta text-foreground hover:bg-muted disabled:text-muted-foreground";

  return (
    <div className="border-t border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <span className="text-meta text-muted-foreground">Filtered JSONL · {entries.length}</span>
        <button type="button" className={buttonClass} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className={buttonClass} onClick={download}>
          Download
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setShow((current) => !current)}
          aria-expanded={show}
        >
          {show ? "Hide readable export" : "Show readable export"}
        </button>
      </div>
      {show ? (
        <section aria-label="Filtered trace JSONL export">
          <pre
            role="document"
            aria-label="Filtered trace JSONL"
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-muted p-2 font-mono text-meta text-foreground"
          >
            {jsonl}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
