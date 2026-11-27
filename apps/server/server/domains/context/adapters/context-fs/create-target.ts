import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import {
  classifyFiletype,
  documentFilenameAt,
  type Filetype,
  filenameForBinary,
  type ParsedDocumentFilename,
  readSegment,
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
  suffix?: string;
};

export type CreateTargetInput = {
  parsedFilename?: ParsedDocumentFilename;
  sourceExtension?: string;
};

function parseTarget(
  scheme: ContextUriScheme,
  path: string,
  input: CreateTargetInput,
): Result<{ dir: string[]; parsed: ParsedDocumentFilename }, AdapterFault> {
  const { dir, filename } = splitPath(path);
  if (!filename) return Err({ code: "io_error", message: "Cannot create source root" });
  if (input.parsedFilename) return Ok({ dir, parsed: input.parsedFilename });
  const parsed = documentFilenameAt(scheme, path, { sourceExtension: input.sourceExtension });
  return parsed.ok ? Ok({ dir, parsed: parsed.value }) : Err(parsed.error);
}

export function resolveCreateTarget(
  scheme: ContextUriScheme,
  path: string,
  input: CreateTargetInput = {},
): Result<CreateTarget, AdapterFault> {
  const target = parseTarget(scheme, path, input);
  if (!target.ok) return target;
  const { dir, parsed } = target.value;
  if (classifyFiletype(parsed.filetype).kind !== "tracked") {
    return Err(binaryTrackedWriteFault(path));
  }
  const { suffix } = readSegment(splitPath(path).filename);
  return Ok({ dir, ...parsed, ...(suffix ? { suffix } : {}) });
}

export function resolveBinaryTarget(
  scheme: ContextUriScheme,
  path: string,
  storage: { fileType: string; mimeType?: string; filename?: { name: string; extension: string } },
): Result<{ dir: string[]; name: string; extension: string }, AdapterFault> {
  if (storage.filename) return Ok({ dir: splitPath(path).dir, ...storage.filename });
  const target = parseTarget(scheme, path, {});
  if (!target.ok) return target;
  const { name, extension } = filenameForBinary(
    target.value.parsed,
    storage.fileType,
    storage.mimeType,
  );
  return Ok({ dir: target.value.dir, name, extension });
}
