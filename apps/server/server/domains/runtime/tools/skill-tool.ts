/**
 * The model `skill` tool (D58) and every other model tool's `skills://`
 * branch. Skills are read-only files (D52): `read` returns a file, one of its
 * `#heading` sections or its outline (D60), `ls` lists folders, and `write`
 * and `search` refuse.
 */
import {
  documentNotFoundMessage,
  markdownSections,
  modelResult,
  normalizeRequestedSlug,
  type ReadToolInput,
  readCall,
  sectionNotFoundMessage,
  splitDocumentFile,
  type WriteErrorStatus,
  type WriteToolInput,
} from "@meridian/agent-edit/integration";
import { meridianErrorFromTool } from "@meridian/contracts/interrupt";
import { z } from "zod";
import {
  isSkillsUri,
  listSkillDir,
  readSkillFile,
  readSkillMd,
  renderSkillFile,
  SKILLS_URI_ROOT,
  type SkillFilesDeps,
  type SkillListEntry,
  visibleSkillNames,
} from "../loop/skill-files.js";
import { type InvalidArgumentIssue, invalidArgumentsResult } from "./invalid-arguments.js";
import { modelToolSchema } from "./model-tool-schema.js";
import type { ToolHandlerContext, ToolRegistration } from "./types.js";

const SkillToolInputSchema = z
  .object({
    name: z.string().min(1).describe("The skill's name as listed, e.g. story-review."),
  })
  .strict();

type SkillToolInput = z.output<typeof SkillToolInputSchema>;

const SKILL_WRITE = "Files under skills:// can only be read.";
const SKILL_SEARCH = "search doesn't cover skills://. Use ls and read.";

function blockSelectorRefusal(field: "in" | "around"): string {
  return `skills:// files have no block hashes, so ${field} doesn't work here. Read the whole file or a #heading.`;
}

const NOT_MARKDOWN = "only markdown files under skills:// have headings. Read the whole file.";

export function createSkillToolRegistrations(deps: SkillFilesDeps): ToolRegistration[] {
  return [
    {
      source: "skill",
      definition: {
        type: "function",
        name: "skill",
        description: "Load a skill listed under Available skills.",
        inputSchema: modelToolSchema(SkillToolInputSchema),
      },
      input: SkillToolInputSchema,
      historyKind: "routine",
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) =>
          invokeSkill(deps, ctx.threadId, (input as SkillToolInput).name),
      },
    },
  ];
}

/** `skill` (D58): `read`'s result for the skill's `SKILL.md`, or the skills it could load instead. */
async function invokeSkill(deps: SkillFilesDeps, threadId: string, name: string) {
  const file = await readSkillMd(deps, threadId, name);
  if (file.kind === "text") return renderSkillFile(file.skill, file.path, file.text);
  const visible = await visibleSkillNames(deps, threadId);
  const missing = `Skill ${JSON.stringify(name)} isn't available.`;
  return {
    isError: true,
    output: {
      message: visible.length
        ? `${missing} Skills you can load: ${visible.join(", ")}.`
        : `${missing} This agent has no skills.`,
    },
  };
}

function readError(status: WriteErrorStatus, message: string, path: string) {
  return {
    isError: true as const,
    output: modelResult({ command: "read", status, payload: { path, message } }),
  };
}

function invalidArguments(issues: InvalidArgumentIssue[]) {
  return { isError: true as const, output: invalidArgumentsResult(issues) };
}

/**
 * `read` of a `skills://` file: the whole file, one `#heading` section, or an
 * outline of its headings (D60), under the shared header. Sections and slugs
 * follow documents; skill files have no block hashes, so `in` and `around`
 * are refused.
 */
export async function readSkill(deps: SkillFilesDeps, threadId: string, input: ReadToolInput) {
  const { path, format } = input;
  const selector = input.in !== undefined ? "in" : input.around !== undefined ? "around" : null;
  if (selector)
    return invalidArguments([{ path: selector, message: blockSelectorRefusal(selector) }]);
  const { filePath, fragment } = splitDocumentFile(path);
  const file = await readSkillFile(deps, threadId, filePath);
  if (file.kind === "binary") {
    return readError("binary_file", "The file is binary, so it can't be read as text.", path);
  }
  if (file.kind === "not_found") {
    return readError("document_not_found", documentNotFoundMessage("read"), path);
  }
  const outline = format === "outline";
  if (fragment === undefined && !outline) return renderSkillFile(file.skill, file.path, file.text);
  if (!file.path.endsWith(".md")) {
    return invalidArguments([
      { path: fragment === undefined ? "format" : "path", message: NOT_MARKDOWN },
    ]);
  }
  const { lines, sections } = markdownSections(file.text);
  const wanted = fragment === undefined ? undefined : normalizeRequestedSlug(fragment);
  const section = wanted === undefined ? null : sections.find(({ slug }) => slug === wanted);
  if (section === undefined) {
    return readError("not_found", sectionNotFoundMessage(fragment ?? ""), path);
  }
  const span = section ?? { start: 0, end: lines.length };
  const address = section ? `${file.path}#${section.slug}` : file.path;
  const headings = sections.filter(({ start }) => start >= span.start && start < span.end);
  // An outline of text with no headings is the text, as a document's is.
  if (!outline || headings.length === 0) {
    return renderSkillFile(
      file.skill,
      address,
      lines.slice(span.start, span.end).join("\n").trimEnd(),
    );
  }
  const uri = `${SKILLS_URI_ROOT}${file.skill}/${file.path}`;
  return renderSkillFile(
    file.skill,
    address,
    [
      "format: outline",
      "",
      ...headings.flatMap(({ heading, slug }) => [heading, readCall(`${uri}#${slug}`)]),
    ].join("\n"),
  );
}

/** The root listing's `skills://` row, only when the agent can see a skill. */
export async function skillsRootEntries(
  deps: SkillFilesDeps,
  threadId: string,
): Promise<SkillListEntry[]> {
  const skills = await listSkillDir(deps, threadId, SKILLS_URI_ROOT);
  return skills.length > 0 ? [{ kind: "directory", uri: SKILLS_URI_ROOT, readonly: true }] : [];
}

/** A `write` naming a `skills://` file as its target or its `from` is refused; null otherwise. */
export function refuseSkillWrite(parsed: WriteToolInput) {
  const from = "from" in parsed ? parsed.from : undefined;
  if (!isSkillsUri(parsed.path) && !(from !== undefined && isSkillsUri(from.path))) return null;
  return {
    isError: true as const,
    output: modelResult({
      command: parsed.command,
      status: "invalid_write",
      payload: { message: SKILL_WRITE },
    }),
  };
}

/** `search` scoped to `skills://` is refused; null otherwise. */
export function refuseSkillSearch(scope: string | undefined) {
  if (!scope || !isSkillsUri(scope)) return null;
  return { isError: true as const, output: meridianErrorFromTool(SKILL_SEARCH) };
}
