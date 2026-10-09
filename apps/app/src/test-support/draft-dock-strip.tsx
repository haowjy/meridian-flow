/**
 * The composer strip's fixtures over the real draft-review scopes
 * (`renderReviewScopes`): a Work's draft list, the previews the server holds,
 * and the strip mounted in the Chat's scope for the chat `thread-a` ("Pacing
 * pass"). The suite supplies the network (`@/client/api/drafts-api`).
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { expect, vi } from "vitest";
import { DraftDock } from "@/features/chat/DraftDock";
import { useDraftDock } from "@/features/chat/useDraftDock";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { listed, operation, preview, renderReviewScopes } from "./draft-review-scope";

export const pacing = { threadId: "thread-a", title: "Pacing pass" };
export const lore = { threadId: "thread-b", title: "Lore pass" };

export type Author = "pacing" | "lore" | "writer";

/** One operation of a change (its class), written by the chat, another chat, or the writer. */
export function op(
  id: string,
  author: Author,
  extra: { classId?: string; canApplyOrDiscard?: boolean } = {},
) {
  const chat = author === "pacing" ? pacing : author === "lore" ? lore : null;
  return {
    ...operation(id),
    closureClassId: extra.classId ?? `class-${id}`,
    ...(extra.canApplyOrDiscard === false ? { canApplyOrDiscard: false } : {}),
    ...(chat ? { actorThreadId: chat.threadId, actorThreadTitle: chat.title } : { kind: "writer" }),
  };
}

/** A listed draft: its id is `draft-<documentId>`, and `chats` are the ones with pending writes in it. */
export function draftItem(
  documentId: string,
  name: string,
  chats: (typeof pacing)[],
  extra: { isNewDocument?: boolean } = {},
) {
  return {
    ...listed,
    draftId: `draft-${documentId}`,
    documentId,
    documentName: name,
    contextPath: `/${name}.md`,
    actorThreads: chats,
    ...extra,
  };
}

/** What the server holds now, by draft. */
export const previews: Record<string, unknown> = {};

export function serverHolds(documentId: string, operations: ReturnType<typeof op>[], extra = {}) {
  previews[`draft-${documentId}`] = {
    ...preview,
    draftId: `draft-${documentId}`,
    liveRevisionToken: `live-${documentId}`,
    draftRevisionToken: `draft-${documentId}`,
    operations,
    ...extra,
  };
}

/** The network's preview read: each draft answers with what `serverHolds` set. */
export async function readPreview(_project: string, _work: string, documentId: string) {
  return previews[`draft-${documentId}`];
}

export function resetServer() {
  for (const key of Object.keys(previews)) delete previews[key];
}

function Strip({ generating }: { generating: boolean }) {
  return <DraftDock dock={useDraftDock({ threadId: "thread-a", generating })} />;
}

export const openWork = vi.fn().mockResolvedValue(undefined);

export function renderStrip(
  listWorkDrafts: ReturnType<typeof vi.fn>,
  run: () => Promise<void>,
  strip: { generating?: boolean } = {},
) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const { generating = false } = strip;
  return renderReviewScopes(
    async () => {
      // The strip mounts with the scopes; wait for its candidates to be listed.
      await vi.waitFor(() => expect(listWorkDrafts).toHaveBeenCalled());
      await run();
    },
    {
      chatSurface: (
        <I18nProvider i18n={i18n}>
          <ProjectNavigationProvider openContextRoute={vi.fn()} openWork={openWork}>
            <Strip generating={generating} />
          </ProjectNavigationProvider>
        </I18nProvider>
      ),
    },
  );
}

export const strip = () => document.querySelector<HTMLElement>("[data-draft-dock]");
export const text = () => strip()?.textContent ?? "";
export const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
export const click = (label: string) =>
  act(async () => {
    button(label)?.click();
  });
export const stripShows = (expected: string) =>
  vi.waitFor(() => expect(text()).toContain(expected));
export const expand = () =>
  act(async () => {
    document.querySelector<HTMLButtonElement>("[aria-expanded]")?.click();
  });
