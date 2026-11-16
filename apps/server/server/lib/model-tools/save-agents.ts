/**
 * `save_agents`: the AI's Save, through the same `savePackages` as the writer's button. An Error in
 * a package's own files comes back as the tool result with Mars's code, key path and message
 * (never a refused write): the files stay as written, so the model fixes them and saves again.
 */
import {
  type AgentsLevel,
  agentsLocationOf,
  type SaveOutcome,
  shownFindings,
} from "@meridian/contracts/agents";
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

/** One finding under the file it is in: the file is named once, above its findings. */
const line = (finding: SaveOutcome["findings"][number]) => {
  const key = finding.path.length ? ` ${finding.path.join(".")}` : "";
  return `  [${finding.code}]${key}: ${finding.message}`;
};

/** Findings grouped under their file, each file named once with what its findings did to it. */
const byFile = (findings: SaveOutcome["findings"], verdict: (file: string) => string): string[] =>
  [...new Set(findings.map((finding) => finding.file))].flatMap((file) => [
    `${file} ${verdict(file)}:`,
    ...findings.filter((finding) => finding.file === file).map(line),
  ]);

/**
 * What the model reads: the items an error keeps out of use first, each with its errors, then what
 * was saved, then warnings and renames.
 */
export function renderSaveOutcomes(outcomes: SaveOutcome[]): string {
  if (outcomes.length === 0)
    return "Nothing to save: those packages have no files and no saved version.";
  return outcomes
    .map((item) => {
      if (item.outcome === "failed") {
        return [
          `Not saved: ${where(item)}. Nothing in it can be read, so ${
            item.savedBefore
              ? "new chats keep the version saved before"
              : "new chats can't use it until it is saved"
          }. Your edits are in the files.`,
          ...byFile(item.findings, () => "fails the check"),
          "Fix these and save again.",
        ].join("\n");
      }
      const held = item.findings.filter(
        (finding) =>
          finding.severity === "error" &&
          (item.kept.includes(finding.file) || item.leftOut.includes(finding.file)),
      );
      const warnings = shownFindings(item.findings).filter(
        (finding) => finding.severity !== "error",
      );
      return [
        ...byFile(held, (file) =>
          item.kept.includes(file)
            ? "fails the check, so this edit isn't in use; its last good save stays in use"
            : "fails the check and has no good save, so it is left out",
        ),
        ...(held.length ? ["Fix these and save again."] : []),
        item.outcome === "unchanged"
          ? `Already saved: ${where(item)} has no ${held.length ? "other " : ""}changes since its saved version.`
          : `Saved ${where(item)}: ${count(item.changes.length, "file")} changed. New chats use it; this chat keeps the version it started with.`,
        ...(warnings.length
          ? ["Warnings (they don't stop a Save):", ...byFile(warnings, () => "has")]
          : []),
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
        "Save Agent packages so new chats use them. Edits to Agent files are not used until saved. An Agent or skill with an error keeps its last saved version (or is not in use if it never had one) and the result says what to fix; save again after fixing. Chats already running keep the version they started with. Only an Agent whose frontmatter says `mode: primary` can start a chat; leave `mode` out, or write `mode: subagent`, for one other Agents call.",
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
          by: "ai",
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
