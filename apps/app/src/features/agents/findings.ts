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

export const findingsOfFile = (findings: readonly AgentFinding[], file: string) =>
  shownFindings(findings).filter((finding) => finding.file === file);

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

export function troubleAfterSave(
  file: AgentFileStatus,
  status: AgentPackageStatus | undefined,
): FileTrouble | null {
  const now = fileTrouble(file, status);
  return now?.kind === "not-in-use" && now.runtime && status && !failsSave(status)
    ? { ...now, kind: "unavailable" }
    : now;
}

export type OutOfUse = {
  file: AgentFileStatus;
  trouble: Extract<FileTrouble, { kind: "unavailable" | "not-in-use" }>;
};

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
