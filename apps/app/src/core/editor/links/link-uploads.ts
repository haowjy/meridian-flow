/**
 * The files on their way up behind links the writer just dropped.
 *
 * A dropped file's chip stands in the document before the file does. What the
 * chip says meanwhile (progress, a failure) is not in the document and not
 * the server's to know, so it is this store's, keyed by the document id the
 * link's `doc:` ref names. A chip in another tab or after a reload has no
 * entry here and hears the server's `uploading` instead.
 *
 * The store is module-wide, not per editor: the writer who drops a large file
 * and opens another document has not asked to stop it, so the upload outlives
 * the editor that started it and a chip drawn later still finds its progress.
 */

import type { UploadIntakeResult } from "@meridian/contracts/protocol";

export type FileUploadState =
  | { kind: "uploading"; percent: number | null }
  | { kind: "failed"; message: string };

/** Sends the file; reports whole percents, or null where the browser cannot say how much there is. */
export type UploadRun = (
  signal: AbortSignal,
  onProgress: (percent: number | null) => void,
) => Promise<UploadIntakeResult>;

type Entry = {
  /** The document whose text holds the link; its editor decides whether the chip is still there. */
  holder: string;
  run: UploadRun;
  state: FileUploadState;
  controller: AbortController;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const publish = () => {
  for (const listener of listeners) listener();
};

function set(documentId: string, entry: Entry, state: FileUploadState): void {
  entries.set(documentId, { ...entry, state });
  publish();
}

async function send(documentId: string, entry: Entry): Promise<void> {
  const { controller } = entry;
  try {
    await entry.run(controller.signal, (percent) => {
      const current = entries.get(documentId);
      if (!current || current.controller !== controller || current.state.kind !== "uploading")
        return;
      if (current.state.percent !== percent)
        set(documentId, current, { kind: "uploading", percent });
    });
    if (entries.get(documentId)?.controller === controller) {
      entries.delete(documentId);
      publish();
    }
  } catch (error) {
    // An abort is the writer taking the file back, not a failure to report.
    const current = entries.get(documentId);
    if (controller.signal.aborted || current?.controller !== controller) return;
    set(documentId, current, {
      kind: "failed",
      message: error instanceof Error ? error.message : "",
    });
  }
}

export const linkUploads = {
  read: (documentId: string): FileUploadState | null => entries.get(documentId)?.state ?? null,

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Starts sending. The entry exists before the first byte, so a chip never draws a gap. */
  begin(documentId: string, holder: string, run: UploadRun): void {
    const entry: Entry = {
      holder,
      run,
      state: { kind: "uploading", percent: null },
      controller: new AbortController(),
    };
    entries.set(documentId, entry);
    publish();
    void send(documentId, entry);
  },

  /** Takes the file back out: whatever is in flight stops. */
  cancel(documentId: string): void {
    const entry = entries.get(documentId);
    if (!entry) return;
    entries.delete(documentId);
    entry.controller.abort();
    publish();
  },

  /** The documents whose upload `holder`'s text should still link to. */
  forHolder(holder: string): string[] {
    return [...entries].flatMap(([documentId, entry]) =>
      entry.holder === holder ? [documentId] : [],
    );
  },
};
