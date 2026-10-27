/**
 * The notices for Copies the server refused, on the surfaces `copyRefusals` names. A refused
 * Copy has already removed its rows; the notice says so, offers Copy to… with the same rows, and
 * stays until the writer dismisses it or copies again. It reads the journal, so it survives a
 * reload and shows in other tabs.
 */
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { type NoticeSurface, SurfaceNotice } from "../../shell/SurfaceNotice";
import { useAccountResourceReplica } from "../account-feature-context";
import { EntryDestinationPicker } from "../EntryDestinationPicker";
import type { CopyRefusal } from "./copy-refusal";
import { OperationFeedbackProvider, useOperationNotices } from "./operation-notice";

export function CopyRefusalNotices({
  surface,
  className,
}: {
  surface: NoticeSurface;
  className?: string;
}) {
  const { projectId, refusals } = useOperationNotices();
  return refusals
    .filter((refusal) => refusal.surfaces.includes(surface))
    .map((refusal) => (
      <RefusedCopy
        key={refusal.operationId}
        projectId={projectId}
        surface={surface}
        refusal={refusal}
        className={className}
      />
    ));
}

function RefusedCopy({
  projectId,
  surface,
  refusal,
  className,
}: {
  projectId: string;
  surface: NoticeSurface;
  refusal: CopyRefusal;
  className?: string;
}) {
  const resources = useAccountResourceReplica();
  const [picking, setPicking] = useState(false);
  const resolve = () => void resources.resolveCopyRefusal(refusal.operationId);
  return (
    <OperationFeedbackProvider feedback={{ surface }}>
      <EntryDestinationPicker
        projectId={projectId}
        action="copy"
        entries={refusal.sources.map((source) => ({ ...source, path: "" }))}
        open={picking}
        onOpenChange={setPicking}
        // The new Copy is the writer's answer to the refused one.
        onPicked={resolve}
      >
        <SurfaceNotice
          className={className}
          notice={{
            message: refusal.message,
            action: { label: <Trans>Copy to…</Trans>, run: () => setPicking(true) },
            undo: null,
            dismiss: resolve,
          }}
        />
      </EntryDestinationPicker>
    </OperationFeedbackProvider>
  );
}
