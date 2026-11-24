import type { StoredMediaPart } from "@meridian/contracts/threads";

export interface LinkWindow {
  startMs: number;
  lengthSeconds: number;
}

export interface ResolvedMedia {
  mediaType: string;
  sizeBytes: number;
  name: string;
  preview?: { mediaType: string; sizeBytes: number };
  source(
    variant: "original" | "preview",
    transport: "link" | "bytes",
  ): Promise<{ url: string } | { data: string } | null>;
}

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
  resolve(
    context: { projectId: string; threadId: string; actorUserId: string },
    part: Pick<StoredMediaPart, "ref" | "mediaType" | "sizeBytes" | "name" | "chatCopy">,
    window: LinkWindow,
  ): Promise<ResolvedMedia | null>;
}

export const unavailableMediaResolver: MediaResolverPort = {
  async resolve() {
    return null;
  },
};
