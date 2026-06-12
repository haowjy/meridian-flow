// @ts-nocheck
import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";

import { useThreadActions, useWorkbenchActions, useWorkbenchStore } from "@/client/stores";
import { i18n } from "@/lib/i18n";
import { startWorkbenchFromPackage } from "@/lib/optimistic-workbench";

import { FIRST_PARTY_PACKAGES } from "./first-party-packages";
import { PackageCard } from "./PackageCard";
import type { PackageCardData } from "./package-card-data";

/**
 * Home section listing the first-party agent packages. Phase 1 visual only —
 * click creates a plain workbench; no actual package install.
 */
export function PackageShowcase() {
  const navigate = useNavigate();
  const workbenchActions = useWorkbenchActions();
  const threadActions = useThreadActions();
  const now = useWorkbenchStore((s) => s.now);

  function handleSelect(pkg: PackageCardData) {
    startWorkbenchFromPackage({
      title: i18n._(pkg.name),
      workbenchActions,
      threadActions,
      navigate,
      now,
    });
  }

  return (
    <section className="mt-12" aria-labelledby="home-packages-heading">
      <h2
        id="home-packages-heading"
        className="mb-3 text-headline-section font-semibold tracking-tight"
      >
        <Trans>Agent Packages</Trans>
      </h2>

      <div className="text-meta mb-2 text-muted-foreground">
        <Trans>Popular</Trans>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-1">
        {FIRST_PARTY_PACKAGES.map((pkg) => (
          <PackageCard key={pkg.id} pkg={pkg} onSelect={handleSelect} />
        ))}
      </div>
    </section>
  );
}
