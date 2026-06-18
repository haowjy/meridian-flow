/** env — shared parsing helpers for environment values at config/runtime boundaries. */

export function readOptionalEnvString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
