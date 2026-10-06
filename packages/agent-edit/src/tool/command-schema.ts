// The agent's document contracts: the `read` input and the `write` mutation union.
//
// Each contract is built twice from the same fields: the model-facing tool input
// names the document `path`, and the engine command names it `file` and adds the
// host-only `documentId` and `tool_use_id`. Neither projection renames fields.
// `move` and `delete` change where a document lives, not its content, so only the
// tool input has them: the host runs them, never the engine.
import { z } from "zod";
import { splitDocumentFile } from "../document-address.js";
import { type CopySourceFields, copySourceIssues } from "./copy-rules.js";
import {
  type ReversalSelectorFields,
  reversalSelectorIssues,
  type SelectorCommand,
  type SelectorFields,
  selectorIssues,
} from "./selector-rules.js";

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

const BLOCK_SELECTOR_DESCRIPTION =
  "Block hash, 1-based block number, or an inclusive [start, end] range of either. Not with `around` or a `#fragment`.";

function blockSelector(description: string) {
  return z
    .union([BlockPositionSchema, z.tuple([BlockPositionSchema, BlockPositionSchema])])
    .meta({ description, modelJsonSchema: BLOCK_SELECTOR_JSON_SCHEMA });
}

const BlockSelectorSchema = blockSelector(BLOCK_SELECTOR_DESCRIPTION);

const FindAroundSchema = z
  .string()
  .min(1)
  .describe("Block hash; search for `find` only near this block. Needs `find`.");

const FindAllSchema = z.boolean().describe("Every match of `find`. Needs `find`.");

const READ_FIELDS = {
  in: BlockSelectorSchema.optional(),
  around: z
    .string()
    .min(1)
    .describe("Block hash to center the read on. Not with `in` or a `#fragment`.")
    .optional(),
  format: z
    .enum(["full", "outline"])
    .describe("Read a long document's `outline` first, then the sections you need.")
    .optional(),
};

// One selector at most; none means the latest write. The rule lives in `reversalSelectorIssues`.
const WRITE_HANDLE_SELECTOR_FIELDS = {
  to: z
    .string()
    .optional()
    .describe(
      "Write handle such as w3; with `since`, the end of a range. Handles are for you; never show them to the user.",
    ),
  since: z.string().optional().describe("With `to`: the first write handle of the range."),
  last: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The last N writes. For redo, the N you undid most recently."),
  all: z.boolean().optional().describe("Every write in this thread."),
};

/**
 * Which version of a document to read (D3, D14). It has no default: omitted
 * means the version this thread's writes change, which the host decides per
 * document. `read`, `search`, `ls` and `from` share this one description.
 */
export const DocumentVersionSchema = z
  .enum(["draft", "live"])
  .describe(
    "Omit for the version your writes change (your Work's draft in draft mode; scratch and other Works are live). `live` reads the text as the user sees it, without draft changes.",
  );
export type DocumentVersion = z.output<typeof DocumentVersionSchema>;

const SOURCE_PATH = z.string().min(1);

/**
 * `from`, the source of a block copy (D23) or a document copy (D24, D49): one
 * shape for every command. It keeps the model's own path: the host resolves
 * and reads it, and the engine only names it in the receipt.
 */
const CopySourceSchema = z
  .object({
    path: SOURCE_PATH,
    in: BlockSelectorSchema.optional(),
    version: DocumentVersionSchema.optional(),
  })
  .strict();

const BLOCK_COPY_SOURCE = CopySourceSchema.describe(
  "Copy these blocks instead of `content`. Give exactly one of `content` or `from`.",
).optional();

const OVERWRITE = z.boolean().optional().describe("Replace an existing document's entire content.");

const MUTATION_BRANCHES = {
  create: {
    description: "Create a document.",
    fields: {
      content: z.string().optional(),
      overwrite: OVERWRITE,
    },
  },
  copy: {
    description: "Copy a document, or part of it, to `path`. The copy starts with its own history.",
    fields: {
      from: CopySourceSchema.describe(
        "Document to copy. Select part of it with `in` or a `#heading-slug` in `path`.",
      ),
      overwrite: OVERWRITE,
    },
  },
  insert: {
    description: "Insert content.",
    fields: {
      content: z.string().min(1).optional(),
      from: BLOCK_COPY_SOURCE,
      after: z.string().min(1).optional().describe("Block hash to insert after. Not with `find`."),
      before: z
        .string()
        .min(1)
        .optional()
        .describe("Block hash to insert before. Not with `find`."),
      find: z.string().min(1).optional().describe("Exact text to insert right after."),
      in: blockSelector(`${BLOCK_SELECTOR_DESCRIPTION} Needs \`find\`.`).optional(),
      around: FindAroundSchema.optional(),
      all: FindAllSchema.optional(),
    },
  },
  replace: {
    description: "Replace blocks selected by in, or the exact text find.",
    fields: {
      content: z.string().optional(),
      from: BLOCK_COPY_SOURCE,
      in: BlockSelectorSchema.optional(),
      find: z
        .string()
        .min(1)
        .optional()
        .describe("Exact text to replace; an empty `content` removes it."),
      around: FindAroundSchema.optional(),
      all: FindAllSchema.optional(),
    },
  },
  remove: {
    description:
      "Remove the blocks selected by `in` or a `#heading-slug` in `path`; to delete the whole document, use `delete`.",
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

/** Whole-document namespace commands (D25, D38): the host runs them; the engine never sees them. */
const NAMESPACE_BRANCHES = {
  move: {
    description:
      "Rename or move the document at `from.path` to `path`. A rename is a move within its folder. Document identity, content and history stay. Links to it follow the move.",
    fields: {
      from: z.object({ path: SOURCE_PATH }).strict().describe("The document to move."),
    },
  },
  delete: {
    description:
      "Delete the whole document at `path`; to remove part of a document, use `remove`. Links to it stop resolving.",
    fields: {},
  },
} as const;

type TargetKey = "file" | "path";

/** Reports the selector rule's issues on the argument each one names. */
function addSelectorIssues(
  ctx: z.RefinementCtx,
  command: SelectorCommand,
  value: SelectorFields & Record<TargetKey, string | undefined>,
  targetKey: TargetKey,
): void {
  for (const issue of selectorIssues(command, value, value[targetKey] ?? "")) {
    const path =
      issue.field === "arguments" ? [] : [issue.field === "target" ? targetKey : issue.field];
    ctx.addIssue({ code: "custom", path, message: issue.message, input: value });
  }
}

function readInput<Target extends z.ZodRawShape>(target: Target, targetKey: TargetKey) {
  return z
    .object({ ...target, ...READ_FIELDS })
    .strict()
    .superRefine((value, ctx) =>
      addSelectorIssues(ctx, "read", value as Parameters<typeof addSelectorIssues>[2], targetKey),
    );
}

function mutationBranches<Target extends z.ZodRawShape>(target: Target) {
  const branch = <Command extends keyof typeof MUTATION_BRANCHES>(command: Command) =>
    z
      .object({
        command: z.literal(command),
        ...target,
        ...(MUTATION_BRANCHES[command].fields as (typeof MUTATION_BRANCHES)[Command]["fields"]),
      })
      .strict()
      .describe(MUTATION_BRANCHES[command].description);
  return [
    branch("create"),
    branch("copy"),
    branch("insert"),
    branch("replace"),
    branch("remove"),
    branch("undo"),
    branch("redo"),
  ] as const;
}

function namespaceBranches<Target extends z.ZodRawShape>(target: Target) {
  const branch = <Command extends keyof typeof NAMESPACE_BRANCHES>(command: Command) =>
    z
      .object({
        command: z.literal(command),
        ...target,
        ...(NAMESPACE_BRANCHES[command].fields as (typeof NAMESPACE_BRANCHES)[Command]["fields"]),
      })
      .strict()
      .describe(NAMESPACE_BRANCHES[command].description);
  return [branch("move"), branch("delete")] as const;
}

/** A namespace command names whole documents, so neither of its paths takes a `#fragment`. */
function addNamespaceIssues(
  ctx: z.RefinementCtx,
  value: { command: string; path?: string; from?: { path: string } },
): void {
  const at = (path: string | undefined) =>
    path === undefined ? undefined : splitDocumentFile(path).fragment;
  if (value.command === "delete" && at(value.path) !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message:
        "delete takes a whole document, so drop the #fragment; to remove a section, use `remove`.",
      input: value,
    });
  }
  if (value.command !== "move") return;
  if (at(value.from?.path) !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["from", "path"],
      message: "move takes a whole document; drop the #fragment from from.path.",
      input: value,
    });
  }
  if (at(value.path) !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "move takes a whole document; drop the #fragment from path.",
      input: value,
    });
  }
}

function refineMutation(value: unknown, ctx: z.RefinementCtx, targetKey: TargetKey): void {
  const fields = value as Parameters<typeof addSelectorIssues>[2] & { command: string };
  const command = fields.command;
  if (command === "insert" || command === "replace" || command === "remove") {
    addSelectorIssues(ctx, command, fields, targetKey);
  }
  if (command === "insert" || command === "replace" || command === "copy") {
    for (const issue of copySourceIssues(command, fields as CopySourceFields)) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message, input: value });
    }
  }
  if (command === "undo" || command === "redo") {
    for (const issue of reversalSelectorIssues(fields as ReversalSelectorFields)) {
      ctx.addIssue({
        code: "custom",
        path: [issue.field],
        message: issue.message,
        input: value,
      });
    }
  }
  if (command === "move" || command === "delete") {
    addNamespaceIssues(ctx, value as Parameters<typeof addNamespaceIssues>[1]);
  }
}

const ENGINE_TARGET = {
  file: z.string().describe("Document path or context URI."),
  documentId: z.string().optional(),
  tool_use_id: z.string().optional(),
};

const READ_TARGET = {
  path: z
    .string()
    .min(1)
    .describe(
      "Document path or context URI; a bare path means `manuscript://`. Append `#heading-slug` for one section.",
    ),
  version: DocumentVersionSchema.optional(),
};
const WRITE_TARGET = {
  path: z
    .string()
    .min(1)
    .describe(
      "The document this command creates or changes: a path or context URI, optionally with `#heading-slug` for one section.",
    ),
};

/** Engine read input: the document and which of its blocks to render. */
export const ReadCommandSchema = readInput(ENGINE_TARGET, "file");
/** Engine mutation input: every engine command changes a document's content. */
export const WriteCommandSchema = z
  .discriminatedUnion("command", mutationBranches(ENGINE_TARGET))
  .superRefine((value, ctx) => refineMutation(value, ctx, "file"));

/** The `read` tool's published input. */
export const ReadToolInputSchema = readInput(READ_TARGET, "path");
/** The `write` tool's published input: the engine's commands plus the host's `move` and `delete`. */
export const WriteToolInputSchema = z
  .discriminatedUnion("command", [
    ...mutationBranches(WRITE_TARGET),
    ...namespaceBranches(WRITE_TARGET),
  ])
  .superRefine((value, ctx) => refineMutation(value, ctx, "path"));

export type ReadCommand = z.infer<typeof ReadCommandSchema>;
export type WriteCommand = z.infer<typeof WriteCommandSchema>;
export type WriteCommandName = WriteCommand["command"];
export type ReadToolInput = z.output<typeof ReadToolInputSchema>;
export type WriteToolInput = z.output<typeof WriteToolInputSchema>;
/** `write`'s commands the host runs itself: they move or delete a whole document. */
export type NamespaceCommandName = Extract<WriteToolInput["command"], "move" | "delete">;

/** Every operation a `read` or `write` result reports. */
export type DocumentCommandName = "read" | WriteToolInput["command"];

export function writeCommandName(input: unknown): WriteToolInput["command"] | undefined {
  if (typeof input !== "object" || input === null || !("command" in input)) return undefined;
  const command = (input as { command?: unknown }).command;
  switch (command) {
    case "create":
    case "copy":
    case "insert":
    case "replace":
    case "remove":
    case "undo":
    case "redo":
    case "move":
    case "delete":
      return command;
    default:
      return undefined;
  }
}
