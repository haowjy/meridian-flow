// The agent's document contracts: the `read` input and the `write` mutation union.
//
// Each contract is built twice from the same fields: the model-facing tool input
// names the document `path`, and the engine command names it `file` and adds the
// host-only `documentId` and `tool_use_id`. Neither projection renames fields.
import { z } from "zod";

/**
 * `in` publishes as one compact JSON Schema instead of zod's nested projection.
 * The schema generator substitutes `modelJsonSchema` metadata for the generated
 * schema; positivity stays a parse check, so it isn't repeated at every use.
 */
const BLOCK_SELECTOR_JSON_SCHEMA = {
  anyOf: [
    { type: ["string", "integer"] },
    {
      type: "array",
      items: { type: ["string", "integer"] },
      minItems: 2,
      maxItems: 2,
    },
  ],
} as const;

const BlockPositionSchema = z.union([z.string().min(1), z.int().positive()]);

const BlockSelectorSchema = z
  .union([BlockPositionSchema, z.tuple([BlockPositionSchema, BlockPositionSchema])])
  .meta({
    description:
      "Block hash, 1-based block number, or an inclusive [start, end] range of either. Not with `around` or a `#fragment`.",
    modelJsonSchema: BLOCK_SELECTOR_JSON_SCHEMA,
  });

const FindAroundSchema = z
  .string()
  .describe("Block hash; search for `find` only near this block. Needs `find`.");

const READ_FIELDS = {
  in: BlockSelectorSchema.optional(),
  around: z
    .string()
    .describe("Block hash to center the read on. Not with `in` or a `#fragment`.")
    .optional(),
  format: z.enum(["full", "outline"]).optional(),
};

// One selector at most; none means the latest write.
const WRITE_HANDLE_SELECTOR_FIELDS = {
  to: z.string().optional().describe("Write handle such as w3; with from, the end of a range."),
  from: z.string().optional().describe("First write handle of a range ending at to."),
  last: z.number().int().min(1).optional().describe("The last N writes."),
  all: z.boolean().optional().describe("Every write in this thread."),
};

const MUTATION_BRANCHES = {
  create: {
    description: "Create a document.",
    fields: {
      content: z.string().optional(),
      overwrite: z.boolean().optional().describe("Replace an existing document's entire content."),
    },
  },
  insert: {
    description: "Insert content.",
    fields: {
      content: z.string(),
      after: z.string().optional().describe("Block hash to insert after."),
      before: z.string().optional().describe("Block hash to insert before."),
      find: z.string().optional().describe("Exact text to insert right after."),
      in: BlockSelectorSchema.optional(),
      around: FindAroundSchema.optional(),
      all: z.boolean().optional(),
    },
  },
  replace: {
    description: "Replace blocks selected by in, or the exact text find.",
    fields: {
      content: z.string(),
      in: BlockSelectorSchema.optional(),
      find: z.string().optional().describe("Exact text to replace; an empty `content` removes it."),
      around: FindAroundSchema.optional(),
      all: z.boolean().optional().describe("Every match of find."),
    },
  },
  remove: {
    description:
      "Remove the blocks selected by `in` or a `#heading-slug` in `path`. Doesn't delete the document. No command deletes whole documents yet.",
    fields: { in: BlockSelectorSchema.optional() },
  },
  undo: {
    description: "Undo this thread's document writes.",
    fields: WRITE_HANDLE_SELECTOR_FIELDS,
  },
  redo: {
    description: "Redo undone writes.",
    fields: WRITE_HANDLE_SELECTOR_FIELDS,
  },
} as const;

function mutationUnion<Target extends z.ZodRawShape>(target: Target) {
  const branch = <Command extends keyof typeof MUTATION_BRANCHES>(command: Command) =>
    z
      .object({
        command: z.literal(command),
        ...target,
        ...(MUTATION_BRANCHES[command].fields as (typeof MUTATION_BRANCHES)[Command]["fields"]),
      })
      .strict()
      .describe(MUTATION_BRANCHES[command].description);
  return z.discriminatedUnion("command", [
    branch("create"),
    branch("insert"),
    branch("replace"),
    branch("remove"),
    branch("undo"),
    branch("redo"),
  ]);
}

const ENGINE_TARGET = {
  file: z.string().describe("Document path or context URI."),
  documentId: z.string().optional(),
  tool_use_id: z.string().optional(),
};

/** The model's path rule lives in each tool description, not on the field. */
const MODEL_TARGET = { path: z.string().min(1) };

/** Engine read input: the document and which of its blocks to render. */
export const ReadCommandSchema = z.object({ ...ENGINE_TARGET, ...READ_FIELDS }).strict();
/** Engine mutation input: every `write` command changes a document. */
export const WriteCommandSchema = mutationUnion(ENGINE_TARGET);

/** The `read` tool's published input. */
export const ReadToolInputSchema = z.object({ ...MODEL_TARGET, ...READ_FIELDS }).strict();
/** The `write` tool's published input. */
export const WriteToolInputSchema = mutationUnion(MODEL_TARGET);

export type ReadCommand = z.infer<typeof ReadCommandSchema>;
export type WriteCommand = z.infer<typeof WriteCommandSchema>;
export type WriteCommandName = WriteCommand["command"];
export type ReadToolInput = z.output<typeof ReadToolInputSchema>;
export type WriteToolInput = z.output<typeof WriteToolInputSchema>;

/** Every operation the engine reports a result for. */
export type DocumentCommandName = "read" | WriteCommandName;

export function writeCommandName(input: unknown): WriteCommandName | undefined {
  if (typeof input !== "object" || input === null || !("command" in input)) return undefined;
  const command = (input as { command?: unknown }).command;
  switch (command) {
    case "create":
    case "insert":
    case "replace":
    case "remove":
    case "undo":
    case "redo":
      return command;
    default:
      return undefined;
  }
}
