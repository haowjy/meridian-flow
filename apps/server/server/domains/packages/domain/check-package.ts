/**
 * The one place Save asks what a package's files publish: Mars's `check()` verdict, which
 * `compilePackage` reads once per package and carries on each item's findings, ordered and graded
 * for Save. Flow's own findings join them (`flow.*`).
 *
 * An error in one Agent's or skill's file leaves that item out of what runs and never fails the
 * Save. Only an error in `mars.toml` does: it leaves nothing in the package readable, and a
 * dependency Mars can't find or read is one (Save has none to fetch yet). Errors come first, then
 * warnings that say an Agent may run wider than its file reads, then other warnings, then Info.
 * Info stays in the package's findings; `shownFindings` (contracts) is what drops it for a list.
 */

import { type CompiledPackage, isError, type PackageDiagnostic } from "./compile-package.js";
import { agentPath, MANIFEST_PATH, skillPath } from "./mars.js";

export interface PackageCheck {
  /** Errors, warnings, then Info, in the package's own files. */
  findings: PackageDiagnostic[];
  /** Errors that leave nothing readable (`mars.toml`): the Save fails and the saved version stays. */
  blocking: PackageDiagnostic[];
  /** Agents and skills with an error, left out of what runs: package-relative paths. */
  leftOut: string[];
}

/** A warning that an Agent may run wider than its file reads: the writer sees these first. */
const isLostRestriction = (item: PackageDiagnostic) =>
  /^field\.(restriction-lost|execution-ignored|retired)$/.test(item.code);

export function checkPackage(pkg: CompiledPackage): PackageCheck {
  const warnings = pkg.findings.filter((item) => item.severity === "warning");
  return {
    findings: [
      ...pkg.findings.filter(isError),
      ...warnings.filter(isLostRestriction),
      ...warnings.filter((item) => !isLostRestriction(item)),
      ...pkg.findings.filter((item) => item.severity === "info"),
    ],
    blocking: pkg.findings.filter((item) => isError(item) && item.file === MANIFEST_PATH),
    leftOut: [
      ...pkg.agents.filter((agent) => !agent.definition).map((agent) => agentPath(agent.slug)),
      ...pkg.skills
        .filter((skill) => skill.diagnostics.some(isError))
        .map((skill) => skillPath(skill.slug)),
    ],
  };
}
