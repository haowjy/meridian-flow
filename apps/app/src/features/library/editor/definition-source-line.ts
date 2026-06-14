/**
 * Definition source line — human provenance label for Library editor headers.
 * Builtins are branded as Meridian; package-installed definitions show their package.
 */
import { t } from "@lingui/core/macro";
import type { AgentSource } from "@meridian/contracts/agents";

export function definitionSourceLine(
  source: AgentSource,
  packageName: string | null,
): string | null {
  if (source === "builtin") return "Meridian";
  if (source === "package" && packageName) return t`from ${packageName}`;
  return null;
}
