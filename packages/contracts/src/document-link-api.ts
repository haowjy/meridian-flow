import { z } from "zod";
import type { DraftId } from "./ids.js";

export const ResolveDocumentLinksRequestSchema = z
  .object({
    rootThreadId: z.string().uuid().nullable().optional(),
    workId: z.string().uuid().nullable().optional(),
    chatId: z.string().uuid().nullable().optional(),
    baseUri: z.string().max(2048).nullable(),
    holderDocumentId: z.string().uuid().optional(),
    links: z
      .array(
        z.object({
          ref: z.string().max(64).nullable(),
          href: z.string().max(2048),
        }),
      )
      .min(1)
      .max(200),
  })
  .refine((request) => !(request.rootThreadId && request.workId), {
    message: "Choose a Work or lineage Scratch owner, not both",
  });

export type ResolveDocumentLinksRequest = z.infer<typeof ResolveDocumentLinksRequestSchema>;

export type DocumentLinkAnswer =
  | {
      state: "document";
      document: {
        id: string;
        title: string;
        scheme: string;
        path: string;
        uri: string;
        workId: string | null;
        rootThreadId?: string | null;
        chatThreadId?: string | null;
        file?: { fileType: string; mimeType: string | null; sizeBytes: number | null };
      };
      inDraft: boolean;
      draft?: { draftId: DraftId };
      settled?: true;
    }
  | {
      state: "folder";
      folder: {
        id: string;
        name: string;
        uri: string;
      };
    }
  | { state: "gone"; settled?: true; trashedDocumentId?: string }
  | { state: "missing"; uri: string }
  | { state: "unresolvable" };

// keep: Link resolution answers stay in request order
export type ResolveDocumentLinksResponse = {
  answers: DocumentLinkAnswer[];
  holderUri?: string;
};
