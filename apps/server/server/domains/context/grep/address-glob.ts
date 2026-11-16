/**
 * Glob filter over addresses relative to a scheme root (`lore/**`, `*chapter-0*`).
 * A pattern with no slash matches the file name at any depth, as ripgrep's `--glob` does;
 * one with a slash matches the whole address. A twin's `~id` is matched with or without, so
 * `*.json` takes `data.json~b21c` too.
 */
import { readSegment } from "@meridian/contracts/protocol";
import picomatch from "picomatch";
import { Err, Ok, type Result } from "../../../shared/result.js";

export type AddressGlob = (address: string) => boolean;

export function compileAddressGlob(glob: string): Result<AddressGlob, string> {
  try {
    const matches = picomatch(glob, { dot: true, basename: !glob.includes("/") });
    const named = (address: string) =>
      address
        .split("/")
        .map((segment) => readSegment(segment).name)
        .join("/");
    return Ok((address) => matches(address) || matches(named(address)));
  } catch (cause) {
    return Err(cause instanceof Error ? cause.message : String(cause));
  }
}
