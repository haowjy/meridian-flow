/**
 * Where a create at a source-relative path lands: its folders and the name codec's
 * canonical name, extension and filetype. Live and draft creates share it, so a drafted
 * `characters/Kael` and a live `characters/Kael.md` name one canonical row.
 */
import {
  classifyFiletype,
  type Filetype,
  filenameForBinary,
  type ParsedDocumentFilename,
  parseDocumentFilename,
} from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { splitPath } from "../../context/paths.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import { binaryTrackedWriteFault } from "./bound-writes.js";

export type CreateTarget = {
  dir: string[];
  name: string;
  extension: string;
  filetype: Filetype;
};

/** How the router already read the destination, or the source extension a bare name inherits. */
export type CreateTargetInput = {
  parsedFilename?: ParsedDocumentFilename;
  sourceExtension?: string;
};

function parseTarget(
  path: string,
  input: CreateTargetInput,
): Result<{ dir: string[]; parsed: ParsedDocumentFilename }, AdapterFault> {
  const { dir, filename } = splitPath(path);
  if (!filename) return Err({ code: "io_error", message: "Cannot create source root" });
  if (input.parsedFilename) return Ok({ dir, parsed: input.parsedFilename });
  const parsed = parseDocumentFilename(filename, { sourceExtension: input.sourceExtension });
  return parsed.ok ? Ok({ dir, parsed: parsed.value }) : Err(parsed.error);
}

/** A tracked document's create target, or the fault a root, invalid or binary name is. */
export function resolveCreateTarget(
  path: string,
  input: CreateTargetInput = {},
): Result<CreateTarget, AdapterFault> {
  const target = parseTarget(path, input);
  if (!target.ok) return target;
  const { dir, parsed } = target.value;
  if (classifyFiletype(parsed.filetype).kind !== "tracked") {
    return Err(binaryTrackedWriteFault(path));
  }
  return Ok({ dir, ...parsed });
}

/** A binary's target: a prose-shaped name takes its storage type's registered suffix. */
export function resolveBinaryTarget(
  path: string,
  storage: { fileType: string; mimeType?: string },
): Result<{ dir: string[]; name: string; extension: string }, AdapterFault> {
  const target = parseTarget(path, {});
  if (!target.ok) return target;
  const { name, extension } = filenameForBinary(
    target.value.parsed,
    storage.fileType,
    storage.mimeType,
  );
  return Ok({ dir: target.value.dir, name, extension });
}
