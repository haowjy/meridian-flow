/**
 * `save_agents`: the AI's Save, through the same `savePackages` as the writer's button. An Error in
 * a package's own files comes back as the tool result with Mars's code, key path and message
 * (never a refused write): the files stay as written, so the model fixes them and saves again.
 */
import { type AgentsLevel, agentsLocationOf, type SaveOutcome } from "@meridian/contracts/agents";
import { meridianErrorFromTool } from "@meridian/contracts/errors";
import type { ThreadId } from "@meridian/contracts/runtime";
import { z } from "zod";
import { parseUnifiedContextUri } from "../../domains/context/index.js";
import type { BoundAgentCatalog } from "../../domains/packages/index.js";
import {
  modelToolSchema,
  renderAsText,
  type ToolHandlerContext,
  type ToolRegistration,
} from "../../domains/runtime/index.js";
import type { ToolWiringDeps } from "./tool-context.js";

const SaveAgentsInputSchema = z
  .object({
    packages: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "The packages to save: `.agents` for the project's own Agent files, `~/.agents` for yours, `.agents/packages/<name>` or `~/.agents/packages/<name>` for an import. A file's path names its package.",
      ),
  })
  .strict();

const LEVEL_NAME: Record<AgentsLevel, string> = { project: ".agents", user: "~/.agents" };

/** The package a path names: the level's own files, or the import it is inside. */
function packageOf(path: string): { level: AgentsLevel; folder: string } | null {
  const parsed = parseUnifiedContextUri(path);
  const at = parsed.ok ? agentsLocationOf(parsed.value.scheme, parsed.value.path) : null;
  if (!at) return null;
  const [dir, name] = at.path.split("/");
  return { level: at.level, folder: dir === "packages" && name ? `packages/${name}/` : "" };
}

const where = (item: Pick<SaveOutcome, "level" | "folder">) =>
  `${LEVEL_NAME[item.level]}${item.folder ? `/${item.folder.replace(/\/$/, "")}` : ""}`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const line = (finding: SaveOutcome["findings"][number]) => {
  const key = finding.path.length ? ` ${finding.path.join(".")}` : "";
  return `  ${finding.file} [${finding.code}]${key}: ${finding.message}`;
};

/** What the model reads: left-out items and their errors first, then what changed, then warnings. */
export function renderSaveOutcomes(outcomes: SaveOutcome[]): string {
  if (outcomes.length === 0)
    return "Nothing to save: those packages have no files and no saved version.";
  return outcomes
    .map((item) => {
      if (item.outcome === "failed") {
        return [
          `Not saved: ${where(item)}. Nothing in it can be read, so the saved version is unchanged. Your edits are in the files.`,
          ...item.findings.map(line),
          "Fix these and save again.",
        ].join("\n");
      }
      const errors = item.findings.filter((finding) => finding.severity === "error");
      const warnings = item.findings.filter((finding) => finding.severity !== "error");
      return [
        ...(item.leftOut.length
          ? [
              `Left out of ${where(item)} until fixed (not used by any chat): ${item.leftOut.join(", ")}`,
              ...errors.map(line),
            ]
          : []),
        item.outcome === "unchanged"
          ? `Already saved: ${where(item)} has no changes since its saved version.`
          : `Saved ${where(item)}: ${count(item.changes.length, "file")} changed. New chats use it; this chat keeps the version it started with.`,
        ...(warnings.length ? ["Warnings:", ...warnings.map(line)] : []),
        ...(item.renamed.length ? [`Renamed: ${item.renamed.join("; ")}`] : []),
      ].join("\n");
    })
    .join("\n\n");
}

export function createSaveAgentsRegistration(
  deps: Pick<ToolWiringDeps, "threads"> & {
    agentCatalog: Pick<BoundAgentCatalog, "savePackages">;
  },
): ToolRegistration {
  return {
    source: "core",
    definition: {
      type: "function",
      name: "save_agents",
      description:
        "Save Agent packages so new chats use them. Edits to Agent files are not used until saved. An Agent or skill with an error is left out of the saved version and the result says what to fix; save again after fixing. Chats already running keep the version they started with.",
      inputSchema: modelToolSchema(SaveAgentsInputSchema),
    },
    input: SaveAgentsInputSchema,
    sequential: true,
    timeoutMs: 30_000,
    execution: {
      type: "server",
      handler: async (input: unknown, ctx: ToolHandlerContext) => {
        const { packages } = input as z.output<typeof SaveAgentsInputSchema>;
        const thread = await deps.threads.findById(ctx.threadId as ThreadId);
        if (!thread) {
          return {
            isError: true,
            output: meridianErrorFromTool("This conversation was not found."),
          };
        }
        const targets = packages.map((path) => ({ path, target: packageOf(path) }));
        const unknown = targets.filter((item) => !item.target).map((item) => item.path);
        if (unknown.length) {
          return {
            isError: true,
            output: meridianErrorFromTool(
              `Not an Agent package: ${unknown.join(", ")}. Name .agents, ~/.agents, or an import under packages/.`,
            ),
          };
        }
        const outcomes = await deps.agentCatalog.savePackages(thread.userId, {
          projectId: thread.projectId,
          packages: targets.flatMap((item) => item.target ?? []),
        });
        // The chat card reads `agentsSaved` from the result's metadata, the model reads the text.
        return { output: { outcomes }, metadata: { agentsSaved: outcomes } };
      },
    },
    renderResult: renderAsText((result: unknown) =>
      renderSaveOutcomes((result as { outcomes: SaveOutcome[] }).outcomes),
    ),
  };
}
