/**
 * What Mars and Flow found in an Agent package, as the writer reads it: each finding in Flow's
 * sentence where Flow has one (Mars's own words otherwise), a package-level problem said once on
 * the package, and what a file's findings make of it.
 */
import { t } from "@lingui/core/macro";
import type {
  AgentFileStatus,
  AgentFinding,
  AgentLevel,
  AgentPackageStatus,
} from "@meridian/contracts/agents";
import { agentsFileOf } from "@meridian/contracts/agents";
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

/**
 * The findings that are causes: an unreadable `mars.toml` also makes Mars read the package as no
 * schema and each Agent in it as no Agent, and those say nothing more.
 */
export function rootFindings(findings: readonly AgentFinding[]): AgentFinding[] {
  const tomlBroken = findings.some((finding) => finding.code === "toml.invalid");
  const packageBroken = findings.some(
    (finding) => finding.severity === "error" && agentsFileOf(finding.file) === null,
  );
  return findings.filter(
    (finding) =>
      !(tomlBroken && finding.code === "flow.package-not-schema-1") &&
      !(packageBroken && finding.code === "flow.file-unreadable"),
  );
}

/** A file's findings in its package, by the package-relative path. */
export const findingsOfFile = (findings: readonly AgentFinding[], file: string) =>
  findings.filter((finding) => finding.file === file);

/**
 * What keeps one Agent or skill file from use, the first that applies:
 * - `unavailable`: it has an Error and no good save is in use, so it isn't in use at all (its name
 *   is struck through);
 * - `not-in-use`: it has an Error, and its last good save stays in use instead of this edit;
 * - `hidden`: a level above has the same name;
 * - `notes`: it works, with warnings.
 * A package-level Error (a broken `mars.toml`) is the package's to say, not each file's.
 */
export type FileTrouble =
  | { kind: "unavailable" | "not-in-use"; problems: string[] }
  | { kind: "hidden"; by: AgentLevel }
  | { kind: "notes"; notes: string[] };

export function fileTrouble(
  file: AgentFileStatus,
  status: AgentPackageStatus | undefined,
): FileTrouble | null {
  const own = file.path.slice(packageFolderOf(file.path).length);
  const findings = status ? findingsOfFile(status.findings, own) : [];
  const packageFails = status !== undefined && failsSave(status);
  const errors = errorsOf(findings);
  if (!packageFails && (errors.length > 0 || file.unavailableReasons.length > 0)) {
    return {
      kind: file.savedVersionInUse ? "not-in-use" : "unavailable",
      problems: errors.length ? errors.map(findingSentence) : file.unavailableReasons,
    };
  }
  if (file.hiddenBy) return { kind: "hidden", by: file.hiddenBy };
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return warnings.length ? { kind: "notes", notes: warnings.map(findingSentence) } : null;
}
