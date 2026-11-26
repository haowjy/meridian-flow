import { createContext, type ReactNode, useContext, useMemo } from "react";

export type EditorScope = {
  projectId: string | null;
  workId: string | null;
  rootThreadId?: string | null;
};

const NO_SCOPE: EditorScope = { projectId: null, workId: null };

const EditorScopeContext = createContext<EditorScope>(NO_SCOPE);

export function EditorScopeProvider({
  projectId,
  workId,
  rootThreadId,
  children,
}: {
  projectId?: string | null;
  workId?: string | null;
  rootThreadId?: string | null;
  children: ReactNode;
}) {
  const scope = useMemo<EditorScope>(
    () => ({
      projectId: projectId ?? null,
      workId: workId ?? null,
      rootThreadId: rootThreadId ?? null,
    }),
    [projectId, workId, rootThreadId],
  );
  return <EditorScopeContext.Provider value={scope}>{children}</EditorScopeContext.Provider>;
}

export function useEditorScope(): EditorScope {
  return useContext(EditorScopeContext);
}
