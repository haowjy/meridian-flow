/** The document address answer: where a document is held now, and the authority that holds it. */
import { z } from "zod";
import { decodeWorkHandle, type WorkHandle } from "../handles.js";
import type { DocumentId, ProjectId, UserId, WorkId } from "../ids.js";
import type { CatalogFileEntry } from "./context-catalog.js";
import { filetypeSchema } from "./filetype.js";

export type AvailabilityGeneration = string;

const CANONICAL_AVAILABILITY_GENERATION = /^(0|[1-9]\d*)$/;

/** Validate the one wire/storage spelling accepted for availability generations. */
export function assertAvailabilityGeneration(
  value: string,
): asserts value is AvailabilityGeneration {
  if (!CANONICAL_AVAILABILITY_GENERATION.test(value)) {
    throw new TypeError(`Invalid availability generation: ${JSON.stringify(value)}`);
  }
}

/** The authenticated user is the account boundary for browser session authority. */
export type AccountId = UserId;

export type ProjectContextAuthority =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId; workHandle: WorkHandle | null }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: string; rootThreadRef: string }
  /** `chatRef` is null while the chat's row does not exist yet (a New chat's first uploads). */
  | { kind: "chat"; projectId: ProjectId; chatId: string; chatRef: string | null };

/** A document the project holds in the tree now, with the authority its source gives it. */
export type AvailableDocument = {
  kind: "available";
  documentId: DocumentId;
  generation: AvailabilityGeneration;
  authority: ProjectContextAuthority;
  entry: CatalogFileEntry;
};

const identity = z.string().min(1);
const version = z.string().regex(/^(0|[1-9]\d*)$/);
const projectAuthority = z.object({ kind: z.literal("project"), projectId: identity });
const userAuthority = z.object({ kind: z.literal("user"), userId: identity });
const workScope = z.object({ kind: z.literal("work"), projectId: identity, workId: identity });
const lineageAuthority = z.object({
  kind: z.literal("lineage"),
  projectId: identity,
  rootThreadId: identity,
  rootThreadRef: identity,
});
const chatAuthority = z.object({
  kind: z.literal("chat"),
  projectId: identity,
  chatId: identity,
  chatRef: identity.nullable(),
});
const authority = z.discriminatedUnion("kind", [
  projectAuthority,
  userAuthority,
  workScope.extend({
    workHandle: z
      .string()
      .refine((value) => decodeWorkHandle(value) !== null)
      .transform((value) => value as WorkHandle)
      .nullable(),
  }),
  lineageAuthority,
  chatAuthority,
]);
const scope = z.discriminatedUnion("kind", [
  projectAuthority,
  userAuthority,
  workScope,
  lineageAuthority.omit({ rootThreadRef: true }),
  chatAuthority.omit({ chatRef: true }),
]);
const fileClassification = z.union([
  z.object({
    extension: z.string(),
    editable: z.literal(true),
    filetype: filetypeSchema,
    schemaType: z.enum(["document", "code"]),
  }),
  z.object({
    extension: z.string(),
    editable: z.literal(false),
    disposition: z.literal("binary"),
    fileType: z.enum(["docx", "image", "pdf", "binary"]),
    mimeType: z.string().nullable(),
  }),
  z.object({
    extension: z.string(),
    editable: z.literal(false),
    disposition: z.literal("custom"),
    fileType: z.enum(["docx", "image", "pdf", "binary"]),
    mimeType: z.string().nullable(),
    filetype: filetypeSchema,
  }),
]);
const fileEntry = z
  .object({
    kind: z.literal("file"),
    observationVersion: version,
    entryId: identity,
    scope,
    sourceId: identity,
    parentId: identity,
    name: z.string(),
    aliases: z.array(z.string()),
    path: z.array(z.string()),
    uri: identity,
    provisionalName: z.boolean(),
    joinedFrom: z.array(identity).optional(),
    upload: z
      .object({
        attachedAt: z.string(),
        used: z.boolean(),
        intakeId: identity,
        locationRevision: version,
      })
      .optional(),
  })
  .and(fileClassification);

/** Full address result: reference admission and browser navigation validate the same evidence. */
export const documentAddressSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["current", "alias"]),
    document: z.object({
      kind: z.literal("available"),
      documentId: identity,
      generation: version,
      authority,
      entry: fileEntry,
    }),
  }),
  z.object({ kind: z.literal("unavailable") }),
]) satisfies z.ZodType<DocumentAddressResult>;

export type DocumentAddressResult =
  | {
      kind: "current" | "alias";
      document: AvailableDocument;
    }
  | { kind: "unavailable" };
