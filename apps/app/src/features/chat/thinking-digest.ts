/**
 * The writer-facing words for a process fold's digest. The counting rule and
 * its numbers come from the view model (`FoldDigest`); this file only formats
 * them with Lingui and `Intl`.
 */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { type FoldDigest, humanizeSkillSlug } from "@meridian/thread-client";

export function thinkingDigest(digest: FoldDigest): string | null {
  // Member expressions keep the catalog's positional `{0}` ids for these messages.
  const clauses: string[] = [];

  if (digest.invokedSkills.length > 0) {
    // The quotes ride inside the value: an apostrophe in an ICU message
    // escapes the placeholder next to it.
    const skills = new Intl.ListFormat(i18n.locale || undefined, {
      style: "long",
      type: "conjunction",
    }).format(digest.invokedSkills.map((slug) => `'${humanizeSkillSlug(slug)}'`));
    clauses.push(t`Invoked ${skills}`);
  }

  if (digest.readDocuments > 0) {
    clauses.push(
      plural(digest.readDocuments, {
        one: "read # document",
        other: "read # documents",
      }),
    );
  }
  const { steps } = digest;
  if (steps > 0) {
    clauses.push(
      plural(steps, {
        one: "# step",
        other: "# steps",
      }),
    );
  }

  const text = clauses.join(", ");
  return text ? capitalizeFirst(text) : null;
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
