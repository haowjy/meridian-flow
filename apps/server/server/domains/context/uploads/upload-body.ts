/** An upload request body read in two steps: a start-of-file window to classify, then the stream. */
import { Readable } from "node:stream";

/** Bytes of the file's start that classification looks at. */
export const UPLOAD_HEAD_BYTES = 8 * 1024;

/** The body was not the declared size. `over` stops at the first extra byte. */
export class UploadSizeError extends Error {
  constructor(readonly kind: "over" | "short") {
    super(`upload body is ${kind} its declared size`);
  }
}

export interface UploadBody {
  /** The file's first bytes, at most `UPLOAD_HEAD_BYTES`. */
  head: Buffer;
  /**
   * The whole file, head included, as one stream that fails with `UploadSizeError` unless it
   * carries exactly the declared size. Destroying it destroys `body`. `stream`, `collect` and
   * `drain` each read the body, so call only one of them, once.
   */
  stream(): Readable;
  /** The whole file in memory, for the few formats that need it: text to bind, a picture to convert. */
  collect(): Promise<Buffer>;
  /** Reads the rest of the body and drops it, so the client still gets its response. */
  drain(): Promise<void>;
}

export async function openUploadBody(body: Readable, sizeBytes: number): Promise<UploadBody> {
  const iterator = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const wanted = Math.min(UPLOAD_HEAD_BYTES, sizeBytes);
  const first: Buffer[] = [];
  let firstBytes = 0;
  while (firstBytes < wanted) {
    const next = await iterator.next();
    if (next.done) break;
    first.push(next.value);
    firstBytes += next.value.length;
  }
  const lead = Buffer.concat(first);

  async function* counted() {
    try {
      let total = lead.length;
      if (total > sizeBytes) throw new UploadSizeError("over");
      yield lead;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        total += next.value.length;
        if (total > sizeBytes) throw new UploadSizeError("over");
        yield next.value;
      }
      if (total < sizeBytes) throw new UploadSizeError("short");
    } finally {
      await iterator.return?.();
    }
  }

  return {
    head: lead.subarray(0, UPLOAD_HEAD_BYTES),
    stream: () => Readable.from(counted(), { objectMode: false }),
    collect: async () =>
      Buffer.concat(await Readable.from(counted(), { objectMode: false }).toArray()),
    drain: async () => {
      for await (const _ of counted()) {
        // dropped
      }
    },
  };
}
