/**
 * What a reference row says, for every menu that offers one.
 *
 * `[[` offers documents and `@` offers documents and pictures, so a document
 * has to read the same in both: the same glyph, the same quiet second column,
 * the same sentence when two pages answer to one name. One row component is how
 * that stays true — two would drift the first time either menu learned
 * something.
 *
 * Three facts per row and three ways of separating them, none of them a
 * punctuation glyph: the icon says what kind of thing this is, the name is the
 * row, and where it lives sits far right in the quiet size. The kind is also
 * spelled for a screen reader, which has no glyph to read — `map` the chapter
 * and `map.png` the picture are one word apart otherwise.
 */

import { t } from "@lingui/core/macro";
import { FilePlus2, FileText, Image } from "lucide-react";

import type { ReferenceItem } from "@/core/references";

export function ReferenceRow({ item }: { item: ReferenceItem }) {
  if (item.kind === "create") {
    return (
      <>
        <FilePlus2 aria-hidden />
        <span className="truncate">{t`Create “${item.name}”`}</span>
        <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">
          {t`links now, page later`}
        </span>
      </>
    );
  }

  if (item.kind === "asset") {
    return (
      <>
        <Image aria-hidden />
        <span className="truncate">{item.name}</span>
        <span className="sr-only">{t`picture`}</span>
        <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">{item.location}</span>
      </>
    );
  }

  return (
    <>
      <FileText aria-hidden />
      <span className="truncate">
        {item.name}
        {item.matchedAlias ? (
          <span className="text-ink-subtle"> {t`(also ${item.matchedAlias})`}</span>
        ) : null}
      </span>
      <span className="sr-only">{t`document`}</span>
      <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">
        {/* Two documents answering to one name resolve to neither, so telling
            them apart by folder would not help: what the writer needs to know
            is that this link will not land until one of them is renamed. */}
        {item.ambiguous ? t`two documents share this name` : item.location}
      </span>
    </>
  );
}
