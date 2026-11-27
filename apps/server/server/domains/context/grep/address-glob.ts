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
