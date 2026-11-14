/** The host's answer to "what can the model be given for this stored file, right now?". */

/**
 * The span a signed link stays identical for: the thread's prompt-cache lifetime. How long the
 * link is valid is a separate, longer span (`linkExpirySeconds`).
 */
export interface LinkWindow {
  /** Unix ms at the window's start; links are signed as of this moment. */
  startMs: number;
  lengthSeconds: number;
}

/** A file as the model request can use it. Obtaining one has checked that the thread may read it. */
export interface ResolvedMedia {
  mediaType: string;
  sizeBytes: number;
  name: string;
  /** What the server made of a type the models can't take (HEIC, BMP, TIFF become WebP). */
  preview?: { mediaType: string; sizeBytes: number };
  /**
   * The gateway source for the original or the preview. `link` yields a link when the object store
   * has one a provider can reach, and bytes when it has none; `bytes` always reads them. Null:
   * the stored object is gone or unreadable, which makes this file unavailable and not the turn.
   */
  source(
    variant: "original" | "preview",
    transport: "link" | "bytes",
  ): Promise<{ url: string } | { data: string } | null>;
}

/** A lookup failed (the database, an unreadable record) without proving that any file is unavailable; the turn fails and retries. */
export class MediaResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaResolutionError";
  }
}

export interface MediaResolverPort {
  diagnose?(input: {
    threadId: string;
    projectId: string;
    reason: "unavailable_or_over_budget";
  }): void;
  /** The runtime treats `ref` as opaque. Null: the file is gone or the thread may not read it. */
  resolve(
    context: { projectId: string; threadId: string; actorUserId: string },
    ref: { documentId: string; uri: string },
    window: LinkWindow,
  ): Promise<ResolvedMedia | null>;
}

export const unavailableMediaResolver: MediaResolverPort = {
  async resolve() {
    return null;
  },
};
