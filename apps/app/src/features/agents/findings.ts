/**
 * What Mars and Flow found in an Agent package, as the writer reads it: each finding in Flow's
 * sentence where Flow has one (Mars's own words otherwise), and what a file's findings make of it.
 */
import { t } from "@lingui/core/macro";
import type {
  AgentFileStatus,
  AgentFinding,
  AgentLevel,
  AgentPackageStatus,
} from "@meridian/contracts/agents";
import { errorsOf, failsSave, packageFolderOf } from "./package-save";

const quoted = (message: string) => /"([^"]+)"|`([^`]+)`/.exec(message)?.slice(1).find(Boolean);

/** One finding in Flow's words; Mars's message when Flow has no sentence for its code. */
export function findingSentence(finding: AgentFinding): string {
  const key = finding.path.map(String).join(".");
  const name = quoted(finding.message);
  switch (finding.code) {
    case "field.type":
    case "field.value":
      if (key === "model") return t`model must be a model's name, like model: sonnet.`;
      break;
    case "field.unknown":
      if (key)
        return t`${key} isn't a key Flow knows, so it has no effect. Check the spelling, or remove it.`;
      break;
    case "flow.skill-missing":
      if (name) return t`No skill is named ${name} in this package.`;
      break;
    case "flow.subagent-missing":
      if (name) return t`No Agent named ${name} is in this package.`;
      break;
    case "flow.subagent-unavailable":
      if (name) return t`Its subagent ${name} is unavailable.`;
      break;
    case "toml.invalid": {
      const at = /line (\d+), column (\d+)/.exec(finding.message);
      return at
        ? t`mars.toml can't be read: line ${at[1]}, column ${at[2]} isn't valid TOML.`
        : t`mars.toml can't be read: it isn't valid TOML.`;
    }
    case "flow.package-not-schema-1":
      return t`mars.toml needs schema = 1 under [package].`;
  }
  return finding.message;
}

/** A file's findings in its package, by the package-relative path. */
export const findingsOfFile = (findings: readonly AgentFinding[], file: string) =>
  findings.filter((finding) => finding.file === file);

/**
 * What keeps one Agent or skill file from use, the first that applies:
 * - `unavailable`: new chats can't use it at all (its name is struck through): it has an Error or
 *   can't run (`runtime`, such as a model the account can't use), and no saved version that runs;
 * - `not-in-use`: this edit has an Error or can't run, and its last good save stays in use instead;
 * - `hidden`: a level above has the same name;
 * - `notes`: it works, with warnings.
 * A package-level Error (a broken `mars.toml`) is the package's to say, not each file's.
 */
export type FileTrouble =
  | { kind: "unavailable" | "not-in-use"; problems: string[]; runtime: boolean }
  | { kind: "hidden"; by: AgentLevel }
  | { kind: "notes"; notes: string[] };

export function fileTrouble(
  file: AgentFileStatus,
  status: AgentPackageStatus | undefined,
): FileTrouble | null {
  const own = file.path.slice(packageFolderOf(file.path).length);
  const findings = status ? findingsOfFile(status.findings, own) : [];
  const errors = status && failsSave(status) ? [] : errorsOf(findings);
  const runtime = file.unavailableReasons;
  if (errors.length > 0 || runtime.length > 0) {
    return {
      kind: file.savedVersionInUse ? "not-in-use" : "unavailable",
      problems: [...errors.map(findingSentence), ...runtime],
      runtime: errors.length === 0,
    };
  }
  if (file.hiddenBy) return { kind: "hidden", by: file.hiddenBy };
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return warnings.length ? { kind: "notes", notes: warnings.map(findingSentence) } : null;
}
