/**
 * The scope one editor is open in: which project, and which Work.
 *
 * Project and Work are the writer's two primitives, and a manuscript is only
 * half the answer to "what can this document reach". A `[[` menu offers the
 * manuscript AND the Work's scratch, the resolver is asked with a Work so
 * `work://notes.md` has a fallback to fall back to, and a door that opens a
 * document has to know which Work's scratch to look in. One value carries all
 * three answers so a second one never has to be threaded later.
 *
 * A provider rather than props on the host: `EditorChromeHost` hands a surface
 * the editor and nothing else, deliberately (no growing prop list, no lane
 * editing a shared file). Scope is the app's answer to that seam — a typed
 * value read where it is needed, which is what lets a surface that needs the
 * project mount through the host like every other one instead of beside it.
 *
 * It is NOT part of `EditorMountIdentity`: a Work changing is runtime scope, not
 * a reason to destroy a collaborative editor and its UndoManager.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";

export type EditorScope = {
  /** Null on a host with no project, where nothing internal can be resolved. */
  projectId: string | null;
  /** The active Work, whose scratch is in reach. Null until one is known. */
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
