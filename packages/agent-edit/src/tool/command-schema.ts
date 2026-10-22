// The agent's document contracts: the `read` input and the `write` mutation union.
//
// Each contract is built twice from the same fields: the model-facing tool input
// names the document `path`, and the engine command names it `file` and adds the
// host-only `documentId` and `tool_use_id`. Neither projection renames fields.
// `move` and `delete` change where a whole document lives, not what it says, so only
// the tool input has them: the host runs them, never the engine.
import { z } from "zod";
import { splitDocumentFile } from "../document-address.js";
import { parseEditHandle } from "../ports/update-journal.js";
import { type CopySourceFields, copySourceIssues } from "./copy-rules.js";
import { type SelectorCommand, type SelectorFields, selectorIssues } from "./selector-rules.js";

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
  "A string is a block hash (even if all digits); an integer is a 1-based block number. Or an inclusive [start, end] range of either. Not with `around` or a `#fragment`.";

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

const EDIT_HANDLE_MESSAGE = "Expected an edit handle, e.g. e5.";

const READ_FIELDS = {
  before: z
    .string()
    .refine((value) => parseEditHandle(value) !== undefined, EDIT_HANDLE_MESSAGE)
    .optional()
    .describe("With `edits` only: list edits older than this handle."),
  in: BlockSelectorSchema.optional(),
  around: z
    .string()
    .min(1)
    .describe("Block hash to center the read on. Not with `in` or a `#fragment`.")
    .optional(),
  format: z
    .enum(["full", "outline", "edits"])
    .describe(
      "Read a long document's `outline` first. `edits` lists your edits newest first with available commands. Not with `in`, `around` or `version`. Handles are for you; never show them to the user.",
    )
    .optional(),
};

const WRITE_HANDLE = z
  .string()
  .refine((value) => parseEditHandle(value) !== undefined, EDIT_HANDLE_MESSAGE);
const INVERSE_COUNT = z
  .int()
  .min(1)
  .max(20)
  .optional()
  .describe("How many edits to undo or redo, all or nothing. Default 1.");

/**
 * Which version of a document to read (D3, D14). It has no default: omitted
 * means the version this thread's writes change, which the host decides per
 * document. `read`, `search`, `ls` and `from` share this one description.
 */
export const DocumentVersionSchema = z
  .enum(["draft", "live"])
  .describe(
    "Omit for the version your writes change (the document's draft in draft mode; scratch and other Works are live). `live` reads the text as the user sees it, without draft changes.",
  );
export type DocumentVersion = z.output<typeof DocumentVersionSchema>;

export const DOCUMENT_NAMES_DESCRIPTION =
  "Documents are named without an extension (`Chapter 13`); code and data files keep theirs (`outline.json`).";

const SOURCE_PATH = z.string().min(1).describe(DOCUMENT_NAMES_DESCRIPTION);

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
    description:
      "Undo count edits (default 1) to this document, newest first, all or nothing. Each edit can be redone separately. Refused if the user applied or discarded one, or anyone edited it since; then use revert.",
    fields: { count: INVERSE_COUNT },
  },
  revert: {
    description:
      'Make a new edit reversing an earlier edit, named by handle from read(format: "edits") or a write result. Parts edited since stay. In draft mode it waits for review.',
    fields: { edit: WRITE_HANDLE },
  },
  redo: {
    description:
      "Redo count edits (default 1), last undone first, all or nothing. Not after you edit this document again.",
    fields: { count: INVERSE_COUNT },
  },
} as const;

/** The host's whole-document commands (D25, D38): `path` is what the command changes. */
const NAMESPACE_BRANCHES = {
  move: {
    description:
      "Move or rename the whole document at `from.path` to `path`. Its identity, content and history stay the same. Links to it follow the move, so don't edit them.",
    fields: {
      from: z.object({ path: SOURCE_PATH }).strict().describe("The document to move."),
    },
  },
  delete: {
    description:
      "Delete the whole document at `path`; to remove part of a document, use `remove`. Links to it stop resolving until it is restored.",
    fields: {},
  },
} as const;

type TargetKey = "file" | "path";

/** A whole-document command names whole documents, so neither of its paths takes a `#fragment`. */
function addNamespaceIssues(
  ctx: z.RefinementCtx,
  value: { command: string; path?: string; from?: { path: string } },
): void {
  const fragment = (path: string | undefined) =>
    path === undefined ? undefined : splitDocumentFile(path).fragment;
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message, input: value });
  if (value.command === "delete" && fragment(value.path) !== undefined)
    issue(
      ["path"],
      "Can't delete a section: `delete` takes a whole document. Use `remove` for the section, or drop the `#fragment` to delete the document.",
    );
  if (value.command !== "move") return;
  if (fragment(value.from?.path) !== undefined)
    issue(
      ["from", "path"],
      "Can't move a section: `move` takes a whole document. Drop the `#fragment` from `from.path` to move the document.",
    );
  if (fragment(value.path) !== undefined)
    issue(
      ["path"],
      "Can't move to a section: `path` must name a whole document. Drop the `#fragment` from `path`.",
    );
}

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
    .superRefine((value, ctx) => {
      addSelectorIssues(ctx, "read", value as Parameters<typeof addSelectorIssues>[2], targetKey);
      const fields = value as {
        format?: string;
        in?: unknown;
        around?: string;
        version?: string;
        before?: string;
      };
      if (fields.format === "edits") {
        for (const field of ["in", "around", "version"] as const)
          if (fields[field] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: "edits is not available with in, around or version",
            });
      } else if (fields.before !== undefined)
        ctx.addIssue({ code: "custom", path: ["before"], message: "before pages edits only" });
    });
}

function branch<Target extends z.ZodRawShape, Fields extends z.ZodRawShape, Command extends string>(
  command: Command,
  target: Target,
  spec: { description: string; fields: Fields },
) {
  return z
    .object({ command: z.literal(command), ...target, ...spec.fields })
    .strict()
    .describe(spec.description);
}

function mutationBranches<Target extends z.ZodRawShape>(target: Target) {
  const of = <Command extends keyof typeof MUTATION_BRANCHES>(command: Command) =>
    branch(
      command,
      target,
      MUTATION_BRANCHES[command] as {
        description: string;
        fields: (typeof MUTATION_BRANCHES)[Command]["fields"];
      },
    );
  return [
    of("create"),
    of("copy"),
    of("insert"),
    of("replace"),
    of("remove"),
    of("undo"),
    of("redo"),
    of("revert"),
  ] as const;
}

function namespaceBranches<Target extends z.ZodRawShape>(target: Target) {
  const of = <Command extends keyof typeof NAMESPACE_BRANCHES>(command: Command) =>
    branch(
      command,
      target,
      NAMESPACE_BRANCHES[command] as {
        description: string;
        fields: (typeof NAMESPACE_BRANCHES)[Command]["fields"];
      },
    );
  return [of("move"), of("delete")] as const;
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
  if (command === "move" || command === "delete")
    addNamespaceIssues(ctx, value as Parameters<typeof addNamespaceIssues>[1]);
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
      "Document path or context URI; a bare path means `manuscript://`. Append `#heading-slug` for one section. " +
        DOCUMENT_NAMES_DESCRIPTION,
    ),
  version: DocumentVersionSchema.optional(),
};
const WRITE_TARGET = {
  path: z
    .string()
    .min(1)
    .describe(
      "The document this command creates or changes: a path or context URI. For `move`, the destination. `move` and `delete` take whole documents; other commands may add `#heading-slug` for one section. " +
        DOCUMENT_NAMES_DESCRIPTION,
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
/** The `write` tool's input: the engine's commands plus the host's `move` and `delete`. */
export const WriteToolInputSchema = z
  .discriminatedUnion("command", [
    ...mutationBranches(WRITE_TARGET),
    ...namespaceBranches(WRITE_TARGET),
  ])
  .superRefine((value, ctx) => refineMutation(value, ctx, "path"));
/**
 * What the model is shown of `write` until drafted `move` and `delete` land: neither reaches
 * the model before both work in draft mode too (D66). PR 3's phase F deletes this, and the
 * tool publishes `WriteToolInputSchema`.
 */
export const PublishedWriteToolInputSchema = z
  .discriminatedUnion("command", mutationBranches(WRITE_TARGET))
  .superRefine((value, ctx) => refineMutation(value, ctx, "path"));

export type ReadCommand = z.infer<typeof ReadCommandSchema>;
export type WriteCommand = z.infer<typeof WriteCommandSchema>;
/** The commands the engine runs. */
export type WriteCommandName = WriteCommand["command"];
export type ReadToolInput = z.output<typeof ReadToolInputSchema>;
export type WriteToolInput = z.output<typeof WriteToolInputSchema>;

/** `write`'s commands the host runs itself: they move or delete a whole document. */
export type NamespaceCommandName = Exclude<WriteToolInput["command"], WriteCommandName>;

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
    case "revert":
    case "move":
    case "delete":
      return command;
    default:
      return undefined;
  }
}
