/** Batched stored-link resolution request and answers, shared by the resolve route and the app. */
import { z } from "zod";

export const ResolveDocumentLinksRequestSchema = z
  .object({
    rootThreadId: z.string().uuid().nullable().optional(),
    workId: z.string().uuid().nullable().optional(),
    /** The holder's URI; null for chat, which alone may fall back to previous locations. */
    baseUri: z.string().max(2048).nullable(),
    /**
     * The holder document, when the client knows it: pins the holder whatever `baseUri`
     * now spells, so its own bindings answer its ahead refs (a renamed holder still reads
     * them).
     */
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

/**
 * On an `ahead:` answer when the route couldn't pin the holder (an ambiguous or stale
 * `baseUri` and no `holderDocumentId`): the answer ignores holder bindings; re-ask with
 * `holderDocumentId`.
 */
type HolderUnresolved = { holderUnresolved?: true };

export type DocumentLinkAnswer =
  | ({
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
      /** Present iff `inDraft`: the draft the chip opens (the reader's own if it uses it, else the oldest). */
      draft?: { draftId: string; workId: string | null };
      /** An ahead ref answered through its settlement: it never answers by address again. */
      settled?: true;
      /**
       * The holder's own binding answered this ahead ref (a published ref): a copy of the
       * link carries `doc:<document.id>`, not the ahead ref.
       */
      holderBound?: true;
    } & HolderUnresolved)
  /** A ref the reader cannot reach: no uri, no title. `settled` as on `document`. */
  | ({ state: "gone"; settled?: true } & HolderUnresolved)
  /** An unsettled ahead ref, or a no-ref address with nothing there: Create. */
  | ({ state: "missing"; uri: string } & HolderUnresolved)
  /** External, malformed, or contextual outside any Work. */
  | { state: "unresolvable" };

/** Answers in request order. */
export type ResolveDocumentLinksResponse = {
  answers: DocumentLinkAnswer[];
  /** The pinned holder's current canonical URI, when it differs from `baseUri` (it moved). */
  holderUri?: string;
};
