/**
 * An internal reference in rendered markdown, and where it goes.
 *
 * The same primitive the manuscript draws, in a surface with no editor in it:
 * the target is classified by [`@/core/links`](../core/links/index.ts), the
 * answer comes from the href-keyed resolution store, and following hands a
 * document id to whoever mounted the runtime.
 *
 * **Unresolved is quiet, and it is not a door.** Serial writers name chapters
 * before they write them, so a reference with nothing behind it is a normal
 * rendered state and never a warning — dashed underline, subdued ink, exactly
 * what the manuscript shows. But unlike the manuscript, the transcript never
 * offers to create the page: a sent message is a record of what was asked, not
 * a place to make new documents from. So an unresolved reference is text, not a
 * control (law 5: absent beats disabled, disabled beats dead).
 *
 * **No runtime is a real state.** In the independent chat surface there is no
 * project to resolve against, and every reference degrades to plain prose with
 * no per-caller knowledge of that fact.
 */

import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";

import {
  classifyLinkTarget,
  isInternalLinkTarget,
  type LinkResolution,
  type LinkResolutionEntry,
  linkTargetHref,
} from "@/core/links";
import { cn } from "@/lib/utils";

import { REFERENCE_TARGET_ATTRIBUTE } from "./internal-references";
import "./internal-reference.css";

/** What a surface needs to make a reference in rendered markdown mean something. */
export type InternalReferenceRuntime = {
  resolution: LinkResolution;
  /** Opens the document a reference resolved to. */
  open: (documentId: string) => void;
};

const RuntimeContext = createContext<InternalReferenceRuntime | null>(null);

export function InternalReferenceProvider({
  runtime,
  children,
}: {
  runtime: InternalReferenceRuntime | null;
  children: ReactNode;
}) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

const NO_SUBSCRIPTION = () => () => {};
const NOTHING = () => null;

/**
 * The element [`remarkInternalReferences`](internal-references.ts) emits. The
 * target rides a `data-` attribute rather than an `href`, so the markdown
 * sanitizer — which has never heard of `manuscript://` — leaves it alone, and
 * every ordinary link in a message keeps the renderer it always had.
 */
export function InternalReference({
  children,
  ...props
}: { children?: ReactNode } & Record<string, unknown>) {
  const spelling = String(props[REFERENCE_TARGET_ATTRIBUTE] ?? "");
  const runtime = useContext(RuntimeContext);
  const target = classifyLinkTarget(spelling);
  const href = target && isInternalLinkTarget(target) ? linkTargetHref(target) : null;
  const entry = useResolution(runtime?.resolution ?? null, href);

  useEffect(() => {
    if (href) runtime?.resolution.request([href]);
  }, [href, runtime]);

  // Nothing to point at, or nothing that could answer: the writer's own words.
  if (!href || !runtime) return <>{children}</>;

  if (entry?.state === "unresolved") {
    return (
      <span className="meridian-reference" data-link-state="unresolved">
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-link-state={entry?.state ?? "pending"}
      onClick={() => void follow(runtime, href)}
      className={cn("meridian-reference", "focus-ring rounded-xs")}
    >
      {children}
    </button>
  );
}

/**
 * A click is the writer asking again, so a failure is retried and a pending
 * answer is waited for rather than dropped. Nothing found means the row
 * re-renders as the quiet state, which is the answer.
 */
async function follow(runtime: InternalReferenceRuntime, href: string): Promise<void> {
  const known = runtime.resolution.read(href);
  const entry =
    known?.state === "resolved" ? known : await runtime.resolution.resolve(href).catch(() => null);
  if (entry?.state === "resolved") runtime.open(entry.document.documentId);
}

function useResolution(
  resolution: LinkResolution | null,
  href: string | null,
): LinkResolutionEntry | null {
  return useSyncExternalStore(
    resolution?.subscribe ?? NO_SUBSCRIPTION,
    () => (resolution && href ? resolution.read(href) : null),
    NOTHING,
  );
}
