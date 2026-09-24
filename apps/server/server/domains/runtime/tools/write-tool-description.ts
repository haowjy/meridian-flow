/** Composes the write-tool instructions from the commands this caller may use. */

import type { WriteCommandName } from "@meridian/agent-edit/integration";

const COMMAND_GUIDANCE: Record<WriteCommandName, string> = {
  read: 'Read with `{ "command": "read", "path": "..." }`.',
  diff: "`diff` inspects this turn’s folded edit result; it does not read a document and requires a Work in draft write mode. Diff is provisional until the trail settles.",
  create: "To replace an entire existing document, use create with overwrite=true.",
  insert: "insert adds content; before/after take block hashes, not text.",
  replace:
    "replace edits content; find replaces only the exact matched span, never following blocks.",
  delete: "delete removes the block or block range selected by in.",
  undo: "undo reverses this thread’s document writes.",
  redo: "redo reapplies this thread’s document writes.",
};

const TARGETED_COMMANDS = new Set<WriteCommandName>(["insert", "replace", "delete"]);

export function writeToolDescription(
  commands: ReadonlySet<string> = new Set(Object.keys(COMMAND_GUIDANCE)),
): string {
  const allowed = [...commands].filter(isWriteCommand);
  const sections = [
    "Document tool. Every call requires an explicit `command`; never omit it.",
    ...allowed.map((command) => COMMAND_GUIDANCE[command]),
    ...(allowed.some((command) => TARGETED_COMMANDS.has(command))
      ? [
          "`in` accepts one block hash or 1-based block number, or an inclusive [start, end] range of hashes or block numbers. Block hashes are internal targeting tokens: use them in tool arguments, but do not quote or label writer-facing prose with hashes unless the writer explicitly asks for edit-protocol details.",
        ]
      : []),
    "Results use the meridian.agent-edit.v1 JSON envelope; each block record separates hash from exact body and says whether body is full or a prefix.",
  ];
  return sections.join(" ");
}

function isWriteCommand(command: string): command is WriteCommandName {
  return Object.hasOwn(COMMAND_GUIDANCE, command);
}
