import { Trans } from "@lingui/react/macro";

import { CorpusImportPanel } from "@/features/corpus-import/CorpusImportPanel";
import { PaneTitle } from "./PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ImportPaneControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
};

export function ImportPaneController({
  projectId,
  sidebarToggle,
  chatToggle,
}: ImportPaneControllerProps) {
  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title={
          <PaneTitle>
            <Trans>Import</Trans>
          </PaneTitle>
        }
        left={sidebarToggle}
        right={chatToggle}
      />
      <CorpusImportPanel projectId={projectId} />
    </main>
  );
}
