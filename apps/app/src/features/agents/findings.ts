/**
 * What Mars and Flow found in an Agent package, as the writer reads it: each finding in Flow's
 * sentence where Flow has one (Mars's own words otherwise), and what a file's findings make of it.
 */
import { plural, t } from "@lingui/core/macro";
import {
  type AgentFileStatus,
  type AgentFinding,
  type AgentLevel,
  type AgentPackageStatus,
  type AgentsLevel,
  shownFindings,
} from "@meridian/contracts/agents";
import { errorsOf, failsSave, type PackageRef, packageFolderOf, statusOf } from "./package-save";

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
      if (key) return t`${key} isn't a known key, so it has no effect`;
      break;
    case "skill-ref.missing": {
      const skill = /references skill `([^`]+)`/.exec(finding.message)?.[1];
      if (skill) return t`No skill is named ${skill} in this package.`;
      break;
    }
    case "flow.subagent-missing":
      if (name) return t`No Agent named ${name} is in this package.`;
      break;
    case "flow.subagent-unavailable":
      if (name) return t`Its subagent ${name} is unavailable.`;
      break;
    case "toml.invalid": {
      const at = /line (\d+), column (\d+)/.exec(finding.message);
      return at
        ? t`mars.toml: invalid TOML at line ${at[1]}, column ${at[2]}`
        : t`mars.toml: invalid TOML`;
    }
    case "flow.package-not-schema-1":
      return t`mars.toml needs schema = 1 under [package].`;
  }
  return finding.message;
}

/** A file's shown findings (no Info) in its package, by the package-relative path. */
export const findingsOfFile = (findings: readonly AgentFinding[], file: string) =>
  shownFindings(findings).filter((finding) => finding.file === file);

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
  const warnings = findings.filter((finding) => finding.severity !== "error");
  return warnings.length ? { kind: "notes", notes: warnings.map(findingSentence) } : null;
}

/**
 * What a Save of the file's package makes of it. An Agent with an Error keeps whatever it had;
 * an edit that is read but can't run (`runtime`) becomes the saved version, which then can't
 * run either. Said the same before the Save answers and after its files are read again.
 */
export function troubleAfterSave(
  file: AgentFileStatus,
  status: AgentPackageStatus | undefined,
): FileTrouble | null {
  const now = fileTrouble(file, status);
  return now?.kind === "not-in-use" && now.runtime && status && !failsSave(status)
    ? { ...now, kind: "unavailable" }
    : now;
}

/** One file out of use, with what keeps it so. */
export type OutOfUse = {
  file: AgentFileStatus;
  trouble: Extract<FileTrouble, { kind: "unavailable" | "not-in-use" }>;
};

/** The level's files under `prefix` that are out of use, each read with `read`. */
export function outOfUseUnder(
  files: readonly AgentFileStatus[],
  packages: readonly AgentPackageStatus[],
  where: { level: AgentsLevel; prefix: string; folder?: string },
  read: typeof fileTrouble = fileTrouble,
): OutOfUse[] {
  return files.flatMap((file) => {
    if (file.level !== where.level || !file.path.startsWith(where.prefix)) return [];
    const folder = packageFolderOf(file.path);
    if (where.folder !== undefined && folder !== where.folder) return [];
    const trouble = read(file, statusOf(packages, { level: where.level, folder }));
    return trouble?.kind === "unavailable" || trouble?.kind === "not-in-use"
      ? [{ file, trouble }]
      : [];
  });
}

/** The files of one package that are out of use, as a Save of it leaves them. */
export const outOfUseAfterSave = (
  files: readonly AgentFileStatus[],
  packages: readonly AgentPackageStatus[],
  pkg: PackageRef,
) =>
  outOfUseUnder(
    files,
    packages,
    { level: pkg.level, prefix: pkg.folder, folder: pkg.folder },
    troubleAfterSave,
  );

/** The count every level says of what it holds out of use: "2 unavailable", else "1 not in use". */
export function outOfUseWord(items: readonly OutOfUse[]): {
  word: string;
  tone: "destructive" | "warning";
  count: number;
} | null {
  const unavailable = items.filter((item) => item.trouble.kind === "unavailable").length;
  if (unavailable)
    return {
      word: plural(unavailable, { one: "# unavailable", other: "# unavailable" }),
      tone: "destructive",
      count: unavailable,
    };
  if (items.length)
    return {
      word: plural(items.length, { one: "# not in use", other: "# not in use" }),
      tone: "warning",
      count: items.length,
    };
  return null;
}
