/**
 * Maps canonical context file metadata to a monochrome kind glyph (rendered at
 * `text-muted-foreground` by the call site). Deliberately mono — tinted
 * per-kind icons were tried in the tree redesign and dropped: the tint was
 * indistinguishable at icon size and read as generic-IDE noise. The glyph
 * *shape* carries the kind; color stays calm.
 */

import {
  classifyFiletype,
  filetypeForKnownPath,
  type ProjectContextTreeFile,
} from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { FileCode, FileImage, FileText, FileType } from "lucide-react";

export function fileKindIcon(file: ProjectContextTreeFile | string): LucideIcon {
  if (typeof file !== "string") {
    if (file.editable) return file.schemaType === "code" ? FileCode : FileText;
    if (file.fileType === "image") return FileImage;
    if (file.fileType === "pdf") return FileType;
    return FileText;
  }

  // Unsaved create/rename suggestions have no server metadata yet, so preview
  // them through the same contracts registry that the server will persist.
  const filetype = filetypeForKnownPath(file);
  if (!filetype) return FileText;
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked")
    return classification.schemaType === "code" ? FileCode : FileText;
  if (classification.kind === "binary" && filetype !== "pdf") return FileImage;
  if (filetype === "pdf") return FileType;
  return FileText;
}
