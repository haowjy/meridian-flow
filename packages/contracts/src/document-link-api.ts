/** Batched stored-link resolution request and answers, shared by the resolve route and the app. */
import { z } from "zod";

export const ResolveDocumentLinksRequestSchema = z
  .object({
    rootThreadId: z.string().uuid().nullable().optional(),
    workId: z.string().uuid().nullable().optional(),
    /** The holder's URI; null for chat, which alone may fall back to previous locations. */
    baseUri: z.string().max(2048).nullable(),
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
      };
      inDraft: boolean;
      /** An ahead ref answered through its settlement: it never answers by address again. */
      settled?: true;
    }
  /** A ref the reader cannot reach: no uri, no title. `settled` as on `document`. */
  | { state: "gone"; settled?: true }
  /** An unsettled ahead ref, or a no-ref address with nothing there: Create. */
  | { state: "missing"; uri: string }
  /** External, malformed, or contextual outside any Work. */
  | { state: "unresolvable" };

/** Answers in request order. */
export type ResolveDocumentLinksResponse = { answers: DocumentLinkAnswer[] };
