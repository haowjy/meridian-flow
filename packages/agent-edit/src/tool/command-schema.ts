// Single source for the agent write(command=...) input contract.
import { z } from "zod";

// One selector at most; none means the latest write.
const WriteHandleSelectorSchema = {
  to: z.string().optional().describe("Write handle such as w3; with from, the end of a range."),
  from: z.string().optional().describe("First write handle of a range ending at to."),
  last: z.number().int().min(1).optional().describe("The last N writes."),
  all: z.boolean().optional().describe("Every write in this thread."),
} as const;

const ScopeTargetSchema = z
  .union([
    z.string(),
    z.number(),
    z.tuple([z.union([z.string(), z.number()]), z.union([z.string(), z.number()])]),
  ])
  .describe("Block hash or 1-based block number, or an inclusive [start, end] range of either.");

const NarrowFindSchema = z.string().optional().describe("Nearby text that narrows find.");

const BaseCommandSchema = z.object({
  file: z.string().describe("Document path or context URI."),
  documentId: z.string().optional(),
  tool_use_id: z.string().optional(),
});

const CreateCommandSchema = BaseCommandSchema.extend({
  command: z.literal("create"),
  content: z.string().optional(),
  overwrite: z.boolean().optional().describe("Replace an existing document's entire content."),
})
  .strict()
  .describe("Create a document.");

const ReadCommandSchema = BaseCommandSchema.extend({
  command: z.literal("read"),
  in: ScopeTargetSchema.optional(),
  around: z.string().optional().describe("Text to center the read on."),
  format: z.enum(["auto", "full", "outline"]).optional(),
})
  .strict()
  .describe("Read a document, or part of one with in or around.");

const DiffCommandSchema = z
  .object({
    command: z.literal("diff"),
    document_id: z.string().optional().describe("Limit to one document."),
    tool_use_id: z.string().optional(),
  })
  .strict()
  .describe(
    "Show the net effect of this turn's writes, provisional until they settle. Needs a Work in draft write mode.",
  );

const InsertCommandSchema = BaseCommandSchema.extend({
  command: z.literal("insert"),
  content: z.string(),
  after: z.string().optional().describe("Block hash to insert after."),
  before: z.string().optional().describe("Block hash to insert before."),
  find: z.string().optional().describe("Exact text to insert right after."),
  in: ScopeTargetSchema.optional(),
  around: NarrowFindSchema,
  all: z.boolean().optional(),
})
  .strict()
  .describe("Insert content.");

const ReplaceCommandSchema = BaseCommandSchema.extend({
  command: z.literal("replace"),
  content: z.string(),
  in: ScopeTargetSchema.optional(),
  find: z.string().optional().describe("Exact text to replace; nothing after it changes."),
  around: NarrowFindSchema,
  all: z.boolean().optional().describe("Every match of find."),
})
  .strict()
  .describe("Replace blocks selected by in, or the exact text find.");

const DeleteCommandSchema = BaseCommandSchema.extend({
  command: z.literal("delete"),
  in: ScopeTargetSchema,
})
  .strict()
  .describe("Delete the blocks selected by in.");

const UndoCommandSchema = BaseCommandSchema.extend({
  command: z.literal("undo"),
  ...WriteHandleSelectorSchema,
})
  .strict()
  .describe("Undo this thread's document writes.");

const RedoCommandSchema = BaseCommandSchema.extend({
  command: z.literal("redo"),
  ...WriteHandleSelectorSchema,
})
  .strict()
  .describe("Redo undone writes.");

export const WriteCommandSchema = z.discriminatedUnion("command", [
  CreateCommandSchema,
  ReadCommandSchema,
  DiffCommandSchema,
  InsertCommandSchema,
  ReplaceCommandSchema,
  DeleteCommandSchema,
  UndoCommandSchema,
  RedoCommandSchema,
]);

export type WriteCommand = z.infer<typeof WriteCommandSchema>;
export type WriteCommandName = WriteCommand["command"];

export function writeCommandName(input: unknown): WriteCommandName | undefined {
  if (typeof input !== "object" || input === null || !("command" in input)) return undefined;
  const command = (input as { command?: unknown }).command;
  switch (command) {
    case "read":
    case "diff":
    case "create":
    case "insert":
    case "replace":
    case "delete":
    case "undo":
    case "redo":
      return command;
    default:
      return undefined;
  }
}
