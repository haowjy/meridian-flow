/**
 * Worker thread that converts one EPUB or PDF, so the parsers never run on the server's event
 * loop and the pool (`convert.ts`) can stop them by terminating the thread. Bundled into its own
 * chunk by `nitro.config.ts`.
 */
import { parentPort } from "node:worker_threads";
import type { ConversionJob, ConversionReply } from "./convert.js";
import { epubToMarkdown } from "./epub-markdown.js";
import { ConversionRefused } from "./limits.js";
import { pdfPageCount, pdfToMarkdown } from "./pdf-markdown.js";

async function convert(job: ConversionJob): Promise<ConversionReply> {
  try {
    if (job.kind === "pdf-pages") return { pages: await pdfPageCount(job.bytes) };
    return { markdown: await (job.kind === "epub" ? epubToMarkdown : pdfToMarkdown)(job.bytes) };
  } catch (error) {
    if (error instanceof ConversionRefused)
      return { refused: { reason: error.reason, message: error.message } };
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

parentPort?.on("message", async ({ id, input }: { id: number; input: ConversionJob }) => {
  parentPort?.postMessage({ id, reply: await convert(input) });
});
