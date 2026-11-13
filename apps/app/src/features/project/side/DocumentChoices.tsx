import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type Ref, useState } from "react";
import { useLiveTabs } from "@/client/project-shell/live-tabs";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerResults, PickerSearch, PickerSection } from "@/components/ui/picker";
import { fileKindIcon } from "../context/context-file-icon";
import { matchFileSuggestions } from "../context/file-suggestions/file-suggestions";
import { SideExplorer } from "./SideExplorer";
import { useSideItem } from "./SideView";

const RECENT_LIMIT = 6;
const FIND_LIMIT = 12;
const FIND_SCHEMES: readonly ProjectContextTreeScheme[] = ["manuscript", "kb", "user"];

/** The folder that holds a document, as a row's meta: it tells two chapters of one name apart. */
function parentFolder(path: string | undefined): string | undefined {
  return path?.split("/").filter(Boolean).slice(0, -1).at(-1);
}

/**
 * The documents that can sit beside a chat, as one list: search, the documents open in main's
 * tabs, recently opened ones, then the file explorer. A document that can't open in the editor
 * can't sit beside: search, tabs and recents leave it out and the explorer lists it
 * disabled; each source says whether its document is editable. It renders in the side's dropdown and in the side's empty pane alike. Recents are only
 * offered here; nothing derives the side from them. `choose` writes the current document.
 */
export function DocumentChoices({
  projectId,
  choose,
  searchRef,
}: {
  projectId: string;
  choose: (documentId: string) => void;
  searchRef?: Ref<HTMLInputElement>;
}) {
  const shown = useSideItem().item;
  const current = shown?.kind === "document" ? shown.documentId : null;
  const { lanes } = useLiveTabs();
  const openTabs = lanes.document.tabs;
  const recent = useRecentDocuments(projectId);
  const catalogs = useContextCatalogViews(projectId, FIND_SCHEMES, {});
  const files = FIND_SCHEMES.flatMap((scheme) =>
    (catalogs[scheme].catalog?.files() ?? []).map((file) => ({ scheme, file })),
  );
  const catalogState = FIND_SCHEMES.some(
    (scheme) => catalogs[scheme].isError && !catalogs[scheme].catalog,
  )
    ? "failed"
    : FIND_SCHEMES.some((scheme) => !catalogs[scheme].catalog)
      ? "loading"
      : "ready";
  const [query, setQuery] = useState("");
  const search = query.trim();
  const found = search
    ? matchFileSuggestions(
        files.flatMap(({ scheme, file }) =>
          file.editable
            ? [
                {
                  entryId: file.documentId,
                  scheme,
                  path: file.path,
                  name: file.name,
                  kind: "file" as const,
                  parents: file.path.split("/").filter(Boolean).slice(0, -1),
                },
              ]
            : [],
        ),
        query,
      ).slice(0, FIND_LIMIT)
    : [];
  const tabs = openTabs.filter(({ document }) => document.kind === "new" || document.editable);
  const openIds = new Set(tabs.map((tab) => tab.document.documentId));
  const recents = recent.documents
    .filter((item) => !openIds.has(item.documentId) && item.editable)
    .slice(0, RECENT_LIMIT);
  const row = (documentId: string, name: string, meta?: string) => {
    const Icon = fileKindIcon(name);
    return (
      <li key={documentId}>
        <ListRow
          density="menu"
          current={documentId === current}
          onOpen={() => choose(documentId)}
          leading={<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          title={name}
          meta={meta}
        />
      </li>
    );
  };
  return (
    <Picker label={t`Documents`}>
      <PickerSearch
        ref={searchRef}
        value={query}
        onChange={setQuery}
        onSubmit={() => {
          const first = found[0];
          if (first) choose(first.entryId);
        }}
        label={t`Find a document`}
      />
      <PickerResults bound="fill">
        {search ? (
          <PickerSection
            label={t`Results`}
            state={
              found.length === 0 ? (
                <ListLine density="menu" iconSlot status={catalogState === "loading"}>
                  {catalogState === "loading" ? (
                    <Trans>Loading…</Trans>
                  ) : catalogState === "failed" ? (
                    <Trans>Couldn't load documents.</Trans>
                  ) : (
                    <Trans>No documents match “{search}”.</Trans>
                  )}
                </ListLine>
              ) : undefined
            }
          >
            {found.map((file) => row(file.entryId, file.name, file.parents.at(-1)))}
          </PickerSection>
        ) : (
          <>
            {tabs.length > 0 ? (
              <PickerSection>
                {tabs.map(({ document }) =>
                  row(
                    document.documentId,
                    document.name,
                    document.kind === "new" ? undefined : parentFolder(document.path),
                  ),
                )}
              </PickerSection>
            ) : null}
            {recents.length > 0 || recent.status === "loading" || recent.status === "error" ? (
              <PickerSection
                label={t`Recently opened`}
                state={
                  recents.length === 0 && recent.status === "loading" ? (
                    <ListLine density="menu" iconSlot status>
                      <Trans>Loading…</Trans>
                    </ListLine>
                  ) : recents.length === 0 && recent.status === "error" ? (
                    <ListLine density="menu" iconSlot>
                      <Trans>Couldn't load recent documents.</Trans>
                    </ListLine>
                  ) : undefined
                }
              >
                {recents.map((item) =>
                  row(
                    item.documentId,
                    item.name,
                    item.address.kind === "document" ? parentFolder(item.address.path) : undefined,
                  ),
                )}
              </PickerSection>
            ) : null}
            <SideExplorer projectId={projectId} current={current} onPick={choose} />
          </>
        )}
      </PickerResults>
    </Picker>
  );
}
