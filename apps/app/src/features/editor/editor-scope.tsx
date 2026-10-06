/**
 * Plain app scope around one Editor host. Link consumers use the holder's
 * Work: Scratch and Uploads read their resource location; project documents
 * use No Work. Route and remembered Work never enter this value.
 * Runtime scope changes never remount the collaborative editor or its undo.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";

export type EditorScope = {
  /** Null on a host with no project, where nothing internal can be resolved. */
  projectId: string | null;
  /** The holder's link Work, including No Work. Null until its location is known. */
  workId: string | null;
};

const NO_SCOPE: EditorScope = { projectId: null, workId: null };

const EditorScopeContext = createContext<EditorScope>(NO_SCOPE);

export function EditorScopeProvider({
  projectId,
  workId,
  children,
}: {
  projectId?: string | null;
  workId?: string | null;
  children: ReactNode;
}) {
  const scope = useMemo<EditorScope>(
    () => ({ projectId: projectId ?? null, workId: workId ?? null }),
    [projectId, workId],
  );
  return <EditorScopeContext.Provider value={scope}>{children}</EditorScopeContext.Provider>;
}

/** Empty outside a provider, which reads as "nothing internal to reach yet". */
export function useEditorScope(): EditorScope {
  return useContext(EditorScopeContext);
}
