// Single source for the agent write(command=...) input contract.
import { z } from "zod";

const WriteHandleSelectorSchema = {
  to: z.string().optional(),
  from: z.string().optional(),
  last: z.number().int().min(1).optional(),
  all: z.boolean().optional(),
} as const;

const ScopeTargetSchema = z
  .union([
    z.string(),
    z.number(),
    z.tuple([z.union([z.string(), z.number()]), z.union([z.string(), z.number()])]),
  ])
  .describe(
    "Block scope: one block hash or 1-based block number, or an inclusive [start, end] range using hashes or block numbers.",
  );

const BaseCommandSchema = z.object({
  file: z.string(),
  documentId: z.string().optional(),
  tool_use_id: z.string().optional(),
});

const CreateCommandSchema = BaseCommandSchema.extend({
  command: z.literal("create"),
  content: z.string().optional(),
  overwrite: z
    .boolean()
    .optional()
    .describe("Set true to replace an entire existing document with content."),
}).strict();

const ReadCommandSchema = BaseCommandSchema.extend({
  command: z.literal("read"),
  in: ScopeTargetSchema.optional(),
  around: z.string().optional(),
  format: z.enum(["auto", "full", "outline"]).optional(),
}).strict();

const DiffCommandSchema = z
  .object({
    command: z.literal("diff"),
    document_id: z
      .string()
      .optional()
      .describe("Optionally narrow the turn's folded net effect to one document."),
    tool_use_id: z.string().optional(),
  })
  .strict()
  .describe(
    "Read the settled net effect of this turn's writes. Results are folded across writes and provisional until the trail settles.",
  );

const InsertCommandSchema = BaseCommandSchema.extend({
  command: z.literal("insert"),
  content: z.string(),
  after: z.string().optional().describe("Block hash to insert after; not literal document text."),
  before: z.string().optional().describe("Block hash to insert before; not literal document text."),
  find: z.string().optional(),
  in: ScopeTargetSchema.optional(),
  around: z.string().optional(),
  all: z.boolean().optional(),
}).strict();

const ReplaceCommandSchema = BaseCommandSchema.extend({
  command: z.literal("replace"),
  content: z.string(),
  in: ScopeTargetSchema.optional(),
  find: z
    .string()
    .optional()
    .describe("Exact text span to replace; following text and blocks are not included."),
  around: z.string().optional(),
  all: z.boolean().optional(),
}).strict();

const DeleteCommandSchema = BaseCommandSchema.extend({
  command: z.literal("delete"),
  in: ScopeTargetSchema,
}).strict();

const UndoCommandSchema = BaseCommandSchema.extend({
  command: z.literal("undo"),
  ...WriteHandleSelectorSchema,
}).strict();

const RedoCommandSchema = BaseCommandSchema.extend({
  command: z.literal("redo"),
  ...WriteHandleSelectorSchema,
}).strict();

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
