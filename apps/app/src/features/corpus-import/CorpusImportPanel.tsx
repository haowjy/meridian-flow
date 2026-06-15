import type { CorpusImportItemResponse, CorpusImportResponse } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileUp, FolderOpen, Loader2, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { importDriveFixture, uploadCorpusFiles } from "@/client/api/corpus-import-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { cn } from "@/lib/utils";

export type CorpusImportPanelProps = {
  projectId: string;
  compact?: boolean;
  onImported?: (result: CorpusImportResponse) => void;
};

type ImportState =
  | { status: "idle" }
  | { status: "uploading"; progress: number | null; label: string }
  | { status: "done"; result: CorpusImportResponse }
  | { status: "error"; message: string };

export function CorpusImportPanel({ projectId, compact, onImported }: CorpusImportPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const [dragging, setDragging] = useState(false);
  const queryClient = useQueryClient();

  const busy = state.status === "uploading";
  const summary = state.status === "done" ? state.result : null;

  function noteImported(result: CorpusImportResponse) {
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.contextTree(projectId, "kb"),
    });
    setState({ status: "done", result });
    onImported?.(result);
  }

  async function importFiles(files: File[]) {
    if (files.length === 0) return;
    setState({
      status: "uploading",
      progress: null,
      label: `Importing ${files.length} file${files.length === 1 ? "" : "s"}…`,
    });
    try {
      const result = await uploadCorpusFiles({
        projectId,
        files,
        onProgress: (progress) =>
          setState({
            status: "uploading",
            progress: progress.percent,
            label: `Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`,
          }),
      });
      noteImported(result);
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function importDrive() {
    setState({ status: "uploading", progress: null, label: "Importing Google Drive fixture…" });
    try {
      noteImported(await importDriveFixture(projectId));
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function filesFromInput(input: HTMLInputElement | null): File[] {
    return input?.files ? Array.from(input.files) : [];
  }

  const resultItems = useMemo(() => summary?.items ?? [], [summary]);

  return (
    <section
      className={cn("flex min-h-0 w-full flex-col", compact ? "app-scroll gap-4" : "app-scroll")}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-[980px] flex-col gap-6",
          compact ? "" : "px-4 py-6 md:px-8 md:py-8",
        )}
      >
        <header className="flex flex-col gap-2">
          <span className="text-meta uppercase tracking-hero-label text-muted-foreground">
            Corpus import
          </span>
          <h1 className="text-[clamp(22px,3vw,30px)] font-semibold leading-tight tracking-prose-heading text-foreground">
            Bring in chapters, notes, and manuscripts
          </h1>
          <p className="max-w-[64ch] text-[13.5px] leading-6 text-ink-muted">
            Import DOCX, Markdown, and plain text into the project knowledge base. Unsupported
            binaries are reported without stopping the batch.
          </p>
        </header>

        <section
          aria-label="Corpus file drop zone"
          className={cn(
            "rounded-2xl border border-dashed border-border bg-card p-6 transition-colors",
            dragging && "bg-accent/40",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <FileUp className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-foreground">Upload a corpus batch</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Drag files here, choose multiple files, or select a folder where the browser
                  supports folder upload.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="focus-ring inline-flex h-9 items-center justify-center rounded-md border border-border-subtle bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                Choose files
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => folderInputRef.current?.click()}
                className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border-subtle bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                <FolderOpen className="size-4" aria-hidden />
                Choose folder
              </button>
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            accept=".docx,.md,.markdown,.txt,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(event) => void importFiles(filesFromInput(event.currentTarget))}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            className="hidden"
            onChange={(event) => void importFiles(filesFromInput(event.currentTarget))}
          />
        </section>

        <div className="rounded-xl border border-border-subtle bg-surface-subtle p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Google Drive one-time pull</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                The provider boundary is wired for Drive import. This launch build ships a fixture
                adapter until OAuth credentials are configured.
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void importDrive()}
              className="focus-ring inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              Import Drive fixture
            </button>
          </div>
        </div>

        {state.status === "uploading" ? (
          <ProgressCard label={state.label} progress={state.progress} />
        ) : null}
        {state.status === "error" ? <ErrorCard message={state.message} /> : null}
        {summary ? <ResultsCard result={summary} items={resultItems} /> : null}
      </div>
    </section>
  );
}

function ProgressCard({ label, progress }: { label: string; progress: number | null }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-card p-4">
      <div className="flex items-center gap-3 text-sm text-foreground">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        <span>{label}</span>
        <span className="ml-auto text-muted-foreground">
          {progress === null ? "Working…" : `${progress}%`}
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${progress ?? 35}%` }}
        />
      </div>
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div>
        <p className="font-medium">Import failed</p>
        <p className="mt-1 text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function ResultsCard({
  result,
  items,
}: {
  result: CorpusImportResponse;
  items: CorpusImportItemResponse[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3 text-sm">
        <CheckCircle2 className="size-4 text-primary" aria-hidden />
        <span className="font-medium text-foreground">Import complete</span>
        <span className="text-muted-foreground">
          {result.importedCount} imported · {result.skippedCount} skipped · {result.failedCount}{" "}
          failed
        </span>
      </div>
      <div className="divide-y divide-border-subtle">
        {items.map((item, index) => (
          <ResultRow key={`${item.filename}-${index}`} item={item} />
        ))}
      </div>
    </div>
  );
}

function ResultRow({ item }: { item: CorpusImportItemResponse }) {
  const tone =
    item.status === "imported"
      ? "text-primary"
      : item.status === "skipped"
        ? "text-muted-foreground"
        : "text-destructive";
  return (
    <div className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{item.title}</p>
        <p className="truncate text-muted-foreground">{item.filename}</p>
      </div>
      <div className={cn("text-left text-sm md:text-right", tone)}>
        {item.status === "imported" ? item.uri : item.reason}
      </div>
    </div>
  );
}
