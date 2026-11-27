import { classifyFiletype, filetypeForKnownPath } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { FileCode, FileImage, FileText, FileType } from "lucide-react";
import type { TreeFile } from "@/core/project-tree/tree-view";

export function fileKindIcon(file: TreeFile | string): LucideIcon {
  if (typeof file !== "string") {
    if (file.editable) return file.schemaType === "code" ? FileCode : FileText;
    if (file.fileType === "image") return FileImage;
    if (file.fileType === "pdf") return FileType;
    return FileText;
  }

  const filetype = filetypeForKnownPath(file);
  if (!filetype) return FileText;
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked")
    return classification.schemaType === "code" ? FileCode : FileText;
  if (classification.kind === "binary" && filetype !== "pdf") return FileImage;
  if (filetype === "pdf") return FileType;
  return FileText;
}
