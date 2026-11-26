import { classifyFiletype, filetypeForPath, readSegment } from "@meridian/contracts/protocol";
import type { OpenDocument } from "@/client/stores";
import type { ContextUri } from "@/lib/context-uri";

export function openDocumentFromDraftGroup(group: {
  documentId: string;
  contextLocation?: Pick<ContextUri, "scheme" | "path"> | null;
  documentName?: string | null;
}): Extract<OpenDocument, { kind: "tracked" }> | null {
  const location = group.contextLocation;
  if (!location?.path) return null;
  const { scheme, path } = location;
  const filetype = filetypeForPath(path);
  const classification = classifyFiletype(filetype);
  if (classification.kind !== "tracked") return null;
  const basename = readSegment(path.slice(path.lastIndexOf("/") + 1)).name;
  return {
    kind: "tracked",
    documentId: group.documentId,
    scheme,
    path,
    name: basename || (group.documentName ?? group.documentId),
    editable: true,
    filetype,
    schemaType: classification.schemaType,
  };
}
