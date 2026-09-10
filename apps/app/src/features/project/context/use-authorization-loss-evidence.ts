/** Account-epoch authorization evidence without opening a document session. */
import { useEffect, useState } from "react";
import { useOptionalProjectContextAvailabilityCoordinator } from "./account-feature-context";

let evidenceProducerSequence = 0;

export function useAuthorizationLossEvidence({
  projectId,
  documentIds,
  enabled,
  onLoss,
}: {
  projectId: string | null | undefined;
  documentIds: readonly string[];
  enabled: boolean;
  onLoss: () => void;
}): boolean {
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const idsKey = [...new Set(documentIds)].sort().join("\u0000");
  const [lost, setLost] = useState(false);

  useEffect(() => setLost(false), [enabled, idsKey, projectId]);
  useEffect(() => {
    if (!availability || !enabled || !projectId || idsKey.length === 0 || lost) return;
    const lease = availability.attachProject(projectId);
    const producer = `authorization-evidence:${++evidenceProducerSequence}`;
    lease.observeAuthorizationLoss(
      producer,
      idsKey.split("\u0000").map((documentId) => ({ documentId })),
      () => {
        setLost(true);
        onLoss();
      },
    );
    return () => lease.release();
  }, [availability, enabled, idsKey, lost, onLoss, projectId]);
  return lost;
}
