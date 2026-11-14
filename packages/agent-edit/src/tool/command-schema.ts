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
 * Which version of a document to read. It has no default: omitted
 * means the version this thread's writes change, which the host decides per
 * document. `read`, `grep`, `ls` and `from` share this one description.
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
 * `from`, the source of a block copy or a document copy: one
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
    description:
      "Create a document, or a folder when `path` ends in `/`. A folder takes no `content`.",
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
      "Undo count edits (default 1) to this document, newest first. The requested count is all or nothing, but each selected edit reverses every content part that still applies. Creation, move, and delete are edits too; name a moved or deleted document by its old path. Each edit can be redone separately. Applied text is reverted; applied tree changes and discarded parts stay unchanged.",
    fields: { count: INVERSE_COUNT },
  },
  revert: {
    description:
      'Make a new edit reversing an earlier edit, named by handle from read(format: "edits") or a write result. Parts edited since stay. In draft mode it waits for review.',
    fields: { edit: WRITE_HANDLE },
  },
  redo: {
    description:
      "Redo count edits (default 1), last undone first. The requested count is all or nothing, but each selected edit restores every content part that still applies, including a document creation. Not after you edit this document again.",
    fields: { count: INVERSE_COUNT },
  },
} as const;

/** The host's tree commands: `path` is what the command changes. */
const NAMESPACE_BRANCHES = {
  move: {
    description:
      "Move or rename a document or folder: from `from.path` to `path` (a folder ends in `/`). Its identity, content and history stay the same, and links to it follow, so don't edit them. To reorder, give the same `path` with `position`. To move several into one folder, give `from.paths` and that folder as `path`. A drafted move waits for the user's review.",
    fields: {
      from: z
        .object({
          path: SOURCE_PATH.optional().describe("The document or folder to move."),
          paths: z
            .array(SOURCE_PATH)
            .min(1)
            .optional()
            .describe("Several to move into the folder `path`; each is decided on its own."),
        })
        .strict(),
      position: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("start") }).strict(),
          z.object({ kind: z.literal("end") }).strict(),
          z.object({ kind: z.enum(["before", "after"]), sibling: SOURCE_PATH }).strict(),
        ])
        .optional()
        .describe(
          "Position among the destination folder's children. Before/after names a sibling path; omit to use normal move placement.",
        ),
    },
  },
  delete: {
    description:
      "Delete the document or folder at `path` (a folder ends in `/`, and goes with what is in it); to remove part of a document, use `remove`. `undo` with the handle restores it. Links to it keep pointing at it and work again only when it is restored, not when a new document takes the path.",
    fields: {},
  },
  restore: {
    description:
      "Bring back a document or folder from Trash, named by the path it had when it was deleted. Use it for what someone else deleted; `undo` takes back your own.",
    fields: {},
  },
} as const;

type TargetKey = "file" | "path";

/** A tree command names whole documents or folders, so none of its paths takes a `#fragment`. */
function addNamespaceIssues(
  ctx: z.RefinementCtx,
  value: { command: string; path?: string; from?: { path?: string; paths?: string[] } },
): void {
  const fragment = (path: string | undefined) =>
    path === undefined ? undefined : splitDocumentFile(path).fragment;
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message, input: value });
  if (
    (value.command === "delete" || value.command === "restore") &&
    fragment(value.path) !== undefined
  )
    issue(
      ["path"],
      `Can't ${value.command} a section: \`${value.command}\` takes a whole document. Drop the \`#fragment\`.`,
    );
  if (value.command !== "move") return;
  const { path, paths } = value.from ?? {};
  if ((path === undefined) === (paths === undefined))
    issue(["from"], "Give exactly one of `from.path` or `from.paths`.");
  for (const item of path === undefined ? (paths ?? []) : [path])
    if (fragment(item) !== undefined)
      issue(
        ["from"],
        "Can't move a section: `move` takes a whole document. Drop the `#fragment` from the path.",
      );
  if (fragment(value.path) !== undefined)
    issue(
      ["path"],
      "Can't move to a section: `path` must name a whole document. Drop the `#fragment` from `path`.",
    );
  if (paths !== undefined && value.path !== undefined && !value.path.endsWith("/"))
    issue(["path"], "With `from.paths`, `path` is the folder they go into: end it with `/`.");
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
    branch(command, target, {
      description: MUTATION_BRANCHES[command].description,
      fields: MUTATION_BRANCHES[command].fields as (typeof MUTATION_BRANCHES)[Command]["fields"],
    });
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
  return [of("move"), of("delete"), of("restore")] as const;
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
  if (command === "move" || command === "delete" || command === "restore")
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
/** The `write` tool's input: the engine's commands plus the host's tree commands. */
export const WriteToolInputSchema = z
  .discriminatedUnion("command", [
    ...mutationBranches(WRITE_TARGET),
    ...namespaceBranches(WRITE_TARGET),
  ])
  .superRefine((value, ctx) => refineMutation(value, ctx, "path"));
export type ReadCommand = z.infer<typeof ReadCommandSchema>;
export type WriteCommand = z.infer<typeof WriteCommandSchema>;
/** The commands the engine runs. */
export type WriteCommandName = WriteCommand["command"];
export type ReadToolInput = z.output<typeof ReadToolInputSchema>;
export type WriteToolInput = z.output<typeof WriteToolInputSchema>;

/** `write`'s commands the host runs itself: they change the tree. */
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
    case "restore":
      return command;
    default:
      return undefined;
  }
}
