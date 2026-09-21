/** Projects compiled Mars tool policy onto Flow advertise and dispatch policy. */
import type { ToolPolicy } from "@meridian/contracts/agents";

export type WriteCommandName =
  | "read"
  | "diff"
  | "create"
  | "insert"
  | "replace"
  | "delete"
  | "undo"
  | "redo";

export type WorkCommandName = "list" | "show" | "switch" | "create" | "update" | "delete";

export interface EffectiveToolPolicy {
  tools: ReadonlySet<string>;
  readCommands: ReadonlySet<WriteCommandName>;
  writeCommands: ReadonlySet<WriteCommandName>;
  workCommands: ReadonlySet<WorkCommandName>;
}

const DOCUMENT_READ_COMMANDS = ["read", "diff"] as const satisfies readonly WriteCommandName[];
const WRITE_MUTATE_COMMANDS = [
  "create",
  "insert",
  "replace",
  "delete",
  "undo",
  "redo",
] as const satisfies readonly WriteCommandName[];
const WORK_NAV_COMMANDS = ["list", "show", "switch"] as const satisfies readonly WorkCommandName[];
const WORK_MUTATE_COMMANDS = [
  "create",
  "update",
  "delete",
] as const satisfies readonly WorkCommandName[];

type CompiledToolFields = {
  tools?: string[] | Record<string, ToolPolicy>;
  "disallowed-tools"?: string[];
};

export function projectToolPolicy(metadata: CompiledToolFields): EffectiveToolPolicy {
  const read = marsAllowed("read", metadata);
  const mutate = marsAllowed("edit", metadata);
  const documentRead = read || mutate;
  const askUser = marsAllowed("ask_user", metadata);

  const readCommands = new Set<WriteCommandName>(documentRead ? DOCUMENT_READ_COMMANDS : []);
  const writeCommands = new Set<WriteCommandName>(mutate ? WRITE_MUTATE_COMMANDS : []);
  const workCommands = new Set<WorkCommandName>([
    ...WORK_NAV_COMMANDS,
    ...(mutate ? WORK_MUTATE_COMMANDS : []),
  ]);

  // Host tools with no Mars name stay attached this slice.
  // spawn is always advertised: named targets come from the roster, and the
  // generic subagent stays available even when the roster is empty.
  // thread_message carries no Mars name either: any thread may message its lineage.
  const tools = new Set<string>(["work", "skill", "spawn", "thread_message"]);
  if (documentRead) tools.add("read");
  if (mutate) tools.add("write");
  if (documentRead) {
    tools.add("ls");
    tools.add("search");
  }
  if (askUser) tools.add("ask_user");

  return { tools, readCommands, writeCommands, workCommands };
}

/** Single per-tool command mapping; callers must not duplicate these lists. */
export function commandSetForTool(
  policy: EffectiveToolPolicy,
  toolName: string,
): ReadonlySet<string> | undefined {
  if (toolName === "read") return policy.readCommands;
  if (toolName === "write") return policy.writeCommands;
  if (toolName === "work") return policy.workCommands;
  return undefined;
}

function marsAllowed(name: string, metadata: CompiledToolFields): boolean {
  if (metadata["disallowed-tools"]?.includes(name)) return false;
  const tools = metadata.tools;
  // Mars empty tools vector is harness default, not deny-all.
  if (tools === undefined || (Array.isArray(tools) && tools.length === 0)) return true;
  if (Array.isArray(tools)) return tools.includes(name);
  return tools[name] !== "deny";
}
