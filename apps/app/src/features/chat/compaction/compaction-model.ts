/**
 * Presentation reads of compaction dividers. The metadata readers live in
 * `@meridian/contracts/threads`.
 */
import { referenceOccurrenceContent, type Turn } from "@meridian/contracts/protocol";
import { type CompactionTrigger, readCompactionFacts } from "@meridian/contracts/threads";
import { readPayloadMarkup } from "../read-payload";

export type DividerState = "pending" | "complete" | "failed" | "cancelled";

/** A document the compaction re-showed, as a read row above its text. */
export type DividerDocument = { uri: string; body: string };

export type DividerView = {
  state: DividerState;
  trigger: CompactionTrigger;
  /** What the writer asked the summary to do (`/compact <instructions>`). */
  instructions: string | null;
  summary: string | null;
  /** Documents the compaction re-showed, in the order it read them. */
  documents: DividerDocument[];
  /** Stats for nerds: the summary's model and the context size either side. */
  model: string | null;
  tokens: { before: number; after: number } | null;
};

/** One divider's view state. */
export function dividerView(turn: Turn): DividerView {
  const facts = readCompactionFacts(turn);
  const state: DividerState =
    turn.status === "pending" || turn.status === "streaming"
      ? "pending"
      : turn.status === "error"
        ? "failed"
        : turn.status === "cancelled"
          ? "cancelled"
          : "complete";
  const tokens =
    facts.tokensBefore !== null && facts.tokensAfter !== null
      ? { before: facts.tokensBefore, after: facts.tokensAfter }
      : null;
  return {
    state,
    trigger: facts.trigger,
    instructions: facts.instructions,
    summary: summaryWithoutDocuments(facts.summary),
    documents: (turn.blocks ?? []).flatMap((block) => {
      const reference = referenceOccurrenceContent(block);
      if (reference?.kind !== "document" || !reference.read) return [];
      return [{ uri: reference.uri, body: readPayloadMarkup(reference.read.result) }];
    }),
    model: facts.model,
    tokens,
  };
}

const DOCUMENTS_HEADING = /^#{1,6}\s+documents to keep open\s*:?\s*$/i;

/** The server's list is the manifest of the read rows below, not summary prose. */
function summaryWithoutDocuments(summary: string | null): string | null {
  if (!summary) return summary;
  const lines = summary.split("\n");
  const at = lines.findIndex((line) => DOCUMENTS_HEADING.test(line.trim()));
  if (at < 0) return summary;
  const next = lines.findIndex((line, index) => index > at && /^#{1,6}\s/u.test(line.trim()));
  const kept = next < 0 ? lines.slice(0, at) : [...lines.slice(0, at), ...lines.slice(next)];
  return kept.join("\n").trim();
}
