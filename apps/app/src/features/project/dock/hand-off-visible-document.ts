/** Transfer only the displayed value; the presentation owner supplies a click-time dock claim. */
import type { ContextTab } from "@/client/stores";
import type { ReviewAddress } from "../presented-document";
import type { ScreenKey } from "../shell/screens";

export function handOffVisibleDocument({
  source,
  destination,
  tab,
  review,
  claim,
  isCurrent,
  transfer,
}: {
  source: ScreenKey;
  destination: ScreenKey;
  tab: ContextTab | null;
  review: ReviewAddress | null;
  claim: () => number;
  isCurrent: (claim: number) => boolean;
  transfer: (
    destination: "chat" | "context",
    tab: ContextTab,
    claim: number,
    review: ReviewAddress | null,
  ) => void;
}) {
  if (!tab || source === destination || destination === "work") return;
  const attempt = claim();
  return {
    tab,
    review,
    afterCommit: () => {
      if (isCurrent(attempt)) transfer(destination, tab, attempt, review);
    },
  };
}
