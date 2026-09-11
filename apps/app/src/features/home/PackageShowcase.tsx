import { Trans } from "@lingui/react/macro";

import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { useCreationComposer } from "@/features/chat/useCreationComposer";
import { i18n } from "@/lib/i18n";

import { FIRST_PARTY_PACKAGES } from "./first-party-packages";
import { PackageCard } from "./PackageCard";
import type { PackageCardData } from "./package-card-data";

/**
 * Home section listing the first-party agent packages. Phase 1 visual only —
 * click creates a plain project; no actual package install.
 */
export function PackageShowcase() {
  const creation = useCreationComposer(null);
  function handleSelect(pkg: PackageCardData) {
    if (!creation.submitLocked) void creation.createEmpty(i18n._(pkg.name), DEFAULT_AGENT_SLUG);
  }

  return (
    <section className="mt-12" aria-labelledby="home-packages-heading">
      <h2 id="home-packages-heading" className="mb-3 text-headline-section tracking-tight">
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
