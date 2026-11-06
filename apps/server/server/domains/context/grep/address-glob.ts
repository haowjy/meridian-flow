/**
 * Glob filter over addresses relative to a scheme root (`lore/**`, `*chapter-0*`).
 * A pattern with no slash matches the file name at any depth, as ripgrep's `--glob` does;
 * one with a slash matches the whole address.
 */
import picomatch from "picomatch";
import { Err, Ok, type Result } from "../../../shared/result.js";

export type AddressGlob = (address: string) => boolean;

export function compileAddressGlob(glob: string): Result<AddressGlob, string> {
  try {
    return Ok(picomatch(glob, { dot: true, basename: !glob.includes("/") }));
  } catch (cause) {
    return Err(cause instanceof Error ? cause.message : String(cause));
  }
}
