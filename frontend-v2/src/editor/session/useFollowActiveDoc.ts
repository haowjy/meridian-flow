import { useEffect } from "react"

import type { DocHandle, OpenDoc } from "./view-controller"

export function useFollowActiveDoc(
  sourceActiveDocId: string | null,
  sourceOpenDocs: OpenDoc[],
  targetActivate: (doc: DocHandle) => void,
): void {
  const sourceDoc = sourceOpenDocs.find((doc) => doc.id === sourceActiveDocId)

  useEffect(() => {
    if (!sourceDoc) return

    targetActivate({ id: sourceDoc.id, name: sourceDoc.name })
  }, [sourceDoc?.id, sourceDoc?.name, targetActivate])
}
