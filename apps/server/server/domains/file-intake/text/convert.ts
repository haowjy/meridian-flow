/**
 * The one way EPUB and PDF files are converted: in a worker thread (`conversion-worker.ts`) that
 * is terminated at the deadline and capped in memory, so a hostile or huge file costs the server
 * a refusal, never a frozen event loop. A later converter is one more job kind.
 */
import { createWorkerPool, WorkerPoolError } from "../worker-pool.js";
import { CONVERSION_LIMITS, ConversionRefused } from "./limits.js";

export type ConversionJob = { kind: "epub" | "pdf" | "pdf-pages"; bytes: Uint8Array };
export type ConversionReply =
  | { markdown: string }
  | { pages: number }
  | { refused: { reason: ConversionRefused["reason"]; message: string } }
  | { failed: string };

const pool = createWorkerPool<ConversionJob, ConversionReply>({
  entry: new URL("./conversion-worker.ts", import.meta.url),
  size: 2,
  maxOldGenerationSizeMb: 512,
});

async function run(job: ConversionJob): Promise<ConversionReply> {
  try {
    return await pool.run(job, CONVERSION_LIMITS.timeMs);
  } catch (error) {
    if (!(error instanceof WorkerPoolError) || error.reason === "unavailable") throw error;
    throw error.reason === "timeout"
      ? new ConversionRefused("timeout", "The conversion took too long.")
      : new ConversionRefused("too_large", "The file needs more memory than a conversion may use.");
  }
}

function unwrap<T extends ConversionReply>(reply: ConversionReply, key: keyof T): T[keyof T] {
  if ("refused" in reply) throw new ConversionRefused(reply.refused.reason, reply.refused.message);
  if ("failed" in reply) throw new Error(reply.failed);
  return (reply as T)[key];
}

/** The file's Markdown. Throws `ConversionRefused` for a file that is refused, hostile or too slow. */
export async function convertToMarkdown(
  source: "epub" | "pdf",
  bytes: Uint8Array,
): Promise<string> {
  return unwrap<{ markdown: string }>(await run({ kind: source, bytes }), "markdown");
}

/** The PDF's page count. Throws `ConversionRefused` for a PDF that can't be opened. */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  return unwrap<{ pages: number }>(await run({ kind: "pdf-pages", bytes }), "pages");
}
