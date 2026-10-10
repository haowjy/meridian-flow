/** Where a tracked create at a source-relative path lands: its folders, name and filetype. */
import type { Filetype } from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { parseFilename, splitPath } from "../../context/paths.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import { trackedFiletypeForPath } from "./bound-writes.js";

export type CreateTarget = {
  dir: string[];
  name: string;
  extension: string;
  filetype: Filetype;
};

/** A tracked document's create target, or the fault a root or binary path is. */
export function resolveCreateTarget(path: string): Result<CreateTarget, AdapterFault> {
  const { dir, filename } = splitPath(path);
  if (!filename) return Err({ code: "io_error", message: "Cannot create source root" });
  const filetype = trackedFiletypeForPath(filename);
  if (!filetype.ok) return filetype;
  return Ok({ dir, ...parseFilename(filename), filetype: filetype.value });
}
