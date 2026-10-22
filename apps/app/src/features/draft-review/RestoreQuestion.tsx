/** The question an Apply all asks before it brings deleted documents back (D79), naming each. */
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";

export function RestoreQuestion({ titles }: { titles: readonly string[] }) {
  useLingui();
  const names = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    titles,
  );
  return titles.length === 1 ? (
    <Trans>Applying brings back {names}, which was deleted from the manuscript.</Trans>
  ) : (
    <Trans>Applying brings back {names}, which were deleted from the manuscript.</Trans>
  );
}
