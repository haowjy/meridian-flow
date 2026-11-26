import {
  type DocumentMatch,
  type GrepBlock,
  type GrepLocate,
  type GrepMatcher,
  GrepStopped,
  grepBlocks,
} from "../../grep/matcher.js";
import type { GrepMode } from "../../ports/context-port.js";

const STORED_SLICE = 50;

export interface GrepRead<Shown> {
  blocks: readonly GrepBlock[];
  revision: string | null;
  locate: GrepLocate;
  shownOf(match: DocumentMatch): Shown | undefined;
}

export interface ScanDocument {
  id: string;
  path: string;
}

export interface ScanHit<Shown> {
  document: ScanDocument;
  match: DocumentMatch | null;
  matchCount: number;
  revision: string | null;
  shown?: Shown;
}

export interface ScanResult<Shown> {
  hits: ScanHit<Shown>[];
  totalFiles: number;
  exact: boolean;
  stopped: boolean;
}

export type ScanOutcome<Value, Fault> = { ok: true; value: Value } | { ok: false; error: Fault };

export async function scanDocuments<Shown, Fault>(input: {
  documents: readonly ScanDocument[];
  stored(ids: string[]): Promise<ReadonlyMap<string, string>>;
  matcher: GrepMatcher;
  mode: GrepMode;
  headLimit: number;
  signal: AbortSignal;
  read(documentId: string): Promise<ScanOutcome<GrepRead<Shown>, Fault>>;
}): Promise<ScanOutcome<ScanResult<Shown>, Fault>> {
  const hits: ScanHit<Shown>[] = [];
  let totalFiles = 0;
  let exact = true;
  let stopped = false;
  let stored: ReadonlyMap<string, string> = new Map();
  try {
    for (const [index, document] of input.documents.entries()) {
      if (input.signal.aborted) throw new GrepStopped();
      // Text for a slice at a time bounds what a scan holds, however many documents it covers.
      if (index % STORED_SLICE === 0)
        stored = await input.stored(
          input.documents.slice(index, index + STORED_SLICE).map(({ id }) => id),
        );
      const full = hits.length >= input.headLimit;
      const loaded: { value?: { read: GrepRead<Shown>; text: string } } = {};
      const load = async (): Promise<ScanOutcome<NonNullable<typeof loaded.value>, Fault>> => {
        if (loaded.value) return { ok: true, value: loaded.value };
        const result = await input.read(document.id);
        if (!result.ok) return result;
        loaded.value = {
          read: result.value,
          text: result.value.blocks.map((block) => block.text).join("\n"),
        };
        return { ok: true, value: loaded.value };
      };
      let text = stored.get(document.id);
      if (text === undefined) {
        if (full) {
          exact = false;
          continue;
        }
        const result = await load();
        if (!result.ok) return result;
        text = result.value.text;
      }
      if (input.matcher.test && !input.matcher.test(text)) continue;
      const matchCount = await input.matcher.count(
        text,
        !full && input.mode !== "files_with_matches",
        input.signal,
      );
      if (matchCount === 0) continue;
      totalFiles += 1;
      if (full) continue;
      if (input.mode !== "content") {
        hits.push({
          document,
          match: null,
          matchCount: input.mode === "count" ? matchCount : 0,
          revision: loaded.value?.read.revision ?? null,
        });
        continue;
      }
      const result = await load();
      if (!result.ok) return result;
      const { read } = result.value;
      const match = await grepBlocks(read.blocks, input.matcher, read.locate, input.signal);
      const shown = read.shownOf(match);
      hits.push({
        document,
        match,
        matchCount,
        revision: read.revision,
        ...(shown ? { shown } : {}),
      });
    }
  } catch (cause) {
    if (!(cause instanceof GrepStopped)) throw cause;
    exact = false;
    stopped = true;
  }
  return { ok: true, value: { hits, totalFiles, exact, stopped } };
}
