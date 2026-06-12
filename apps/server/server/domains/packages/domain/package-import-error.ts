// @ts-nocheck
/**
 * Package import failures surfaced as MeridianError-shaped errors for HTTP/WS boundaries.
 */
import {
  type MeridianError,
  meridianError,
  meridianErrorFromSystem,
} from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/threads";

import type { MarsDependency } from "./types.js";

export class PackageImportError extends Error {
  readonly meridianError: MeridianError;

  constructor(meridianError: MeridianError) {
    super(meridianError.message);
    this.name = "PackageImportError";
    this.meridianError = meridianError;
  }
}

export function packageDependencyUnresolved(
  dependency: MarsDependency,
  reason: string,
): PackageImportError {
  return new PackageImportError(
    meridianError({
      code: "package_dependency_unresolved",
      message: reason,
      source: "system",
      retryable: false,
      details: JSON.parse(JSON.stringify(dependency)) as JsonValue,
    }),
  );
}

export function packageImportError(message: string): PackageImportError {
  return new PackageImportError(meridianErrorFromSystem("package_import_failed", message, false));
}

export function isPackageImportError(error: unknown): error is PackageImportError {
  return error instanceof PackageImportError;
}
