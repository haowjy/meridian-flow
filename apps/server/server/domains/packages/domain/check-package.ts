/**
 * The one place Save asks whether a package's files can be published. Until Mars's `check()` is
 * released this is `compilePackage`'s findings graded by severity; `check()` replaces the body
 * and fills the two lists that are empty now (a dependency's own faults, and what waits on a
 * dependency that is not fetched yet).
 */
import { type CompiledPackage, isError, type PackageDiagnostic } from "./compile-package.js";

export interface PackageCheck {
  /** Errors and warnings located in the package's own files. Any error fails the Save. */
  findings: PackageDiagnostic[];
  /** Faults in vendored dependencies: shown on their files, never failing the Save. */
  dependencyFindings: PackageDiagnostic[];
  /** Agents whose refs wait on a dependency that is not fetched yet. */
  notChecked: string[];
}

export function checkPackage(pkg: CompiledPackage): PackageCheck {
  return {
    findings: pkg.findings.filter((item) => item.severity !== "info"),
    dependencyFindings: [],
    notChecked: [],
  };
}

export const errorsOf = (check: PackageCheck): PackageDiagnostic[] =>
  check.findings.filter(isError);
