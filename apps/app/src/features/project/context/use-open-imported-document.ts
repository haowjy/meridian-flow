/** Opens a document named by its context URI (the import report's items) in the Editor. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";

export function useOpenImportedDocument(editorWorkId: string | null) {
  const open = useOpenDocumentInEditor();
  return useCallback(
    (uri: string) => {
      const parsed = parseContextUri(uri);
      if (!parsed.ok || !isProjectContextTreeScheme(parsed.value.scheme)) return;
      open({
        scheme: parsed.value.scheme,
        path: `/${parsed.value.path}`,
        workId: editorWorkId ?? undefined,
      });
    },
    [open, editorWorkId],
  );
}
