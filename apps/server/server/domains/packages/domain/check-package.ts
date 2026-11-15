/**
 * The one place Save asks what a package's files publish. Until Mars's `check()` is released this
 * is `compilePackage`'s findings graded by severity; `check()` replaces the body and fills the
 * list that is empty now (a dependency's own faults).
 *
 * An error in one Agent's or skill's file leaves that item out of what runs and never fails the
 * Save. Only an error in `mars.toml` does: it leaves nothing in the package readable. Errors come
 * first, then warnings that say an Agent may run wider than its file reads.
 */

import { type CompiledPackage, isError, type PackageDiagnostic } from "./compile-package.js";
import { agentPath, MANIFEST_PATH, skillPath } from "./mars.js";

export interface PackageCheck {
  /** Errors then warnings in the package's own files; errors first. */
  findings: PackageDiagnostic[];
  /** Errors that leave nothing readable (`mars.toml`): the Save fails and the saved version stays. */
  blocking: PackageDiagnostic[];
  /** Agents and skills with an error, left out of what runs: package-relative paths. */
  leftOut: string[];
  /** Faults in vendored dependencies: shown on their files, never failing the Save. */
  dependencyFindings: PackageDiagnostic[];
}

/** A warning that an Agent may run wider than its file reads: the writer sees these first. */
const isLostRestriction = (item: PackageDiagnostic) =>
  /^field\.(restriction-lost|execution-ignored|set-aside)$/.test(item.code);

export function checkPackage(pkg: CompiledPackage): PackageCheck {
  const shown = pkg.findings.filter((item) => item.severity !== "info");
  const warnings = shown.filter((item) => !isError(item));
  return {
    findings: [
      ...shown.filter(isError),
      ...warnings.filter(isLostRestriction),
      ...warnings.filter((item) => !isLostRestriction(item)),
    ],
    blocking: shown.filter((item) => isError(item) && item.file === MANIFEST_PATH),
    leftOut: [
      ...pkg.agents.filter((agent) => !agent.definition).map((agent) => agentPath(agent.slug)),
      ...pkg.skills
        .filter((skill) => skill.diagnostics.some(isError))
        .map((skill) => skillPath(skill.slug)),
    ],
    dependencyFindings: [],
  };
}
