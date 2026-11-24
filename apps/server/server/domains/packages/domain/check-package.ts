import {
  type CompiledPackage,
  isError,
  losesRestriction,
  type PackageDiagnostic,
} from "./compile-package.js";
import { agentPath, MANIFEST_PATH, skillPath } from "./mars.js";

export interface PackageCheck {
  findings: PackageDiagnostic[];
  blocking: PackageDiagnostic[];
  leftOut: string[];
}

export function checkPackage(pkg: CompiledPackage): PackageCheck {
  const warnings = pkg.findings.filter((item) => item.severity === "warning");
  return {
    findings: [
      ...pkg.findings.filter(isError),
      ...warnings.filter(losesRestriction),
      ...warnings.filter((item) => !losesRestriction(item)),
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
