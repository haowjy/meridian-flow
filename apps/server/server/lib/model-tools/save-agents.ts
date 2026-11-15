/**
 * `save_agents`: the AI's Save, through the same `savePackages` as the writer's button. An Error in
 * a package's own files comes back as the tool result with Mars's code, key path and message
 * (never a refused write): the files stay as written, so the model fixes them and saves again.
 */
import type { AgentsLevel, SaveOutcome } from "@meridian/contracts/agents";
import { meridianErrorFromTool } from "@meridian/contracts/errors";
import type { ThreadId } from "@meridian/contracts/runtime";
import { z } from "zod";
import type { BoundAgentCatalog } from "../../domains/packages/index.js";
import {
  modelToolSchema,
  renderAsText,
  type ToolHandlerContext,
  type ToolRegistration,
} from "../../domains/runtime/index.js";
import { agentsLocationOfUri } from "../agents-widening.js";
import { areaOfPath } from "./shown-paths.js";
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
  const area = areaOfPath(path);
  const at = area ? agentsLocationOfUri(`${area.area}${area.rest}`) : null;
  if (!at) return null;
  const [dir, name] = at.path.split("/");
  return { level: at.level, folder: dir === "packages" && name ? `packages/${name}/` : "" };
}

const where = (item: Pick<SaveOutcome, "level" | "folder">) =>
  `${LEVEL_NAME[item.level]}${item.folder ? `/${item.folder.replace(/\/$/, "")}` : ""}`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function renderSaveOutcomes(outcomes: SaveOutcome[]): string {
  if (outcomes.length === 0)
    return "Nothing to save: those packages have no files and no saved version.";
  return outcomes
    .map((item) => {
      const lines: string[] = [];
      if (item.outcome === "failed") {
        lines.push(
          `Not saved: ${where(item)}. Your edits are in the files; the saved version is unchanged.`,
        );
        for (const finding of item.findings) {
          const key = finding.path.length ? ` ${finding.path.join(".")}` : "";
          lines.push(`  ${finding.file} [${finding.code}]${key}: ${finding.message}`);
        }
        lines.push("Fix these and save again.");
        return lines.join("\n");
      }
      lines.push(
        item.outcome === "unchanged"
          ? `Already saved: ${where(item)} has no changes since its saved version.`
          : `Saved ${where(item)}: ${count(item.changes.length, "file")} changed. New chats use it; this chat keeps the version it started with.`,
      );
      if (item.findings.length) {
        lines.push("Warnings:");
        for (const finding of item.findings) {
          const key = finding.path.length ? ` ${finding.path.join(".")}` : "";
          lines.push(`  ${finding.file} [${finding.code}]${key}: ${finding.message}`);
        }
      }
      if (item.widened.length) lines.push(`Widened: ${item.widened.join("; ")}`);
      if (item.renamed.length) lines.push(`Renamed: ${item.renamed.join("; ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function createSaveAgentsRegistration(
  deps: Pick<ToolWiringDeps, "threads" | "readChainPermission"> & {
    agentCatalog: Pick<BoundAgentCatalog, "savePackages">;
  },
): ToolRegistration {
  return {
    source: "core",
    definition: {
      type: "function",
      name: "save_agents",
      description:
        "Save Agent packages so new chats use them. Edits to Agent files are not used until saved. A package with an error in its files is not saved, and the result says what to fix; save again after fixing. Chats already running keep the version they started with.",
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
        if ((await deps.readChainPermission(ctx.threadId as ThreadId)) !== "edit") {
          return {
            isError: true,
            output: meridianErrorFromTool("Your permission is read: you can't save Agent files."),
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
