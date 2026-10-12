/** Findings and skip lines as sentences, grouped as the report shows them. Codes in, words out. */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import type {
  ImportEntryReason,
  ImportFinding,
  ImportFindingParams,
  ImportSkipReason,
} from "@meridian/contracts";
import { parseContextUri } from "@meridian/contracts/context-uri";

export type FindingGroup =
  | "hidden"
  | "links"
  | "pictures"
  | "kept"
  | "settings"
  | "other"
  | "renamed";

type Params = Record<string, unknown>;
const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

const AREAS: Record<string, () => string> = {
  manuscript: () => t`Manuscript`,
  kb: () => t`Knowledge Base`,
  unfiled: () => t`Unfiled`,
  user: () => t`User`,
};

/** A context URI as the writer reads a location: "Knowledge Base / Characters / Lin Feng". */
export function readableLocation(value: string): string {
  if (!value.includes("://")) return value;
  const parsed = parseContextUri(value);
  if (!parsed.ok) return value;
  const area = AREAS[parsed.value.scheme]?.() ?? parsed.value.scheme;
  return [area, ...parsed.value.path.split("/").filter(Boolean)].join(" / ");
}
const num = (value: unknown) => (typeof value === "number" ? value : 0);

/** Which report section a finding belongs to. */
export function findingGroup(code: ImportFinding["code"]): FindingGroup {
  switch (code) {
    case "hidden_notes":
      return "hidden";
    case "link_to_existing":
    case "link_via_alias":
    case "link_ambiguous":
    case "link_unresolved":
    case "heading_not_followed":
    case "block_ref_dropped":
    case "link_target_unavailable":
      return "links";
    case "note_embed_to_link":
    case "embed_to_link":
    case "image_size_dropped":
      return "pictures";
    case "kept_as_text":
      return "kept";
    case "settings_unreadable":
      return "settings";
    case "name_clash":
    case "folder_note":
    case "binary_extension":
    case "zip":
      return "renamed";
    case "properties_unreadable":
      return "other";
    default:
      return unhandled(code, "other");
  }
}

/** A code the contract added without a home here fails to compile. */
function unhandled<T>(code: never, fallback: T): T {
  void code;
  return fallback;
}

/** One finding as a sentence (what is on the document's row). */
export function findingSentence(finding: ImportFinding): string {
  const params = finding.params as Params;
  switch (finding.code) {
    case "hidden_notes": {
      const count = num(params.count);
      return plural(count, { one: "# note", other: "# notes" });
    }
    case "link_to_existing": {
      const text = str(params.text);
      const path = readableLocation(str(params.path));
      return t`"${text}" opens ${path}, which was already in your project.`;
    }
    case "link_via_alias": {
      const text = str(params.text);
      const path = readableLocation(str(params.path));
      return t`"${text}" opens ${path} through one of its aliases.`;
    }
    case "link_ambiguous": {
      const text = str(params.text);
      const chosen = str(params.path);
      const path = readableLocation(chosen);
      const count = i18n.number(num(params.count));
      const others = (Array.isArray(params.candidates) ? params.candidates : [])
        .filter(
          (candidate): candidate is string => typeof candidate === "string" && candidate !== chosen,
        )
        .map(readableLocation);
      // The files it did not pick follow, one per line.
      return [t`"${text}" matched ${count} files. It opens ${path}.`, ...others].join("\n");
    }
    case "link_unresolved": {
      const text = str(params.text);
      const folder = readableLocation(str(params.folder));
      return t`"${text}" doesn't match any file yet. Opening it offers to create it in ${folder}.`;
    }
    case "heading_not_followed": {
      const text = str(params.text);
      const name = str(params.name);
      const heading = str(params.heading);
      return t`"${text}" opens ${name} at the top, not at ${heading}.`;
    }
    case "block_ref_dropped": {
      const text = str(params.text);
      const name = str(params.name);
      return t`"${text}" opens ${name}. Links to a single paragraph aren't kept.`;
    }
    case "link_target_unavailable": {
      const text = str(params.text);
      const path = readableLocation(str(params.path));
      return text
        ? t`"${text}" points to ${path}, which isn't available.`
        : t`A link here points to a file that isn't available.`;
    }
    case "note_embed_to_link": {
      const name = str(params.name);
      return t`The embedded note ${name} is now a link to it.`;
    }
    case "embed_to_link": {
      const name = str(params.name);
      return t`The embedded file ${name} is now a link to it.`;
    }
    case "image_size_dropped": {
      const name = str(params.name);
      const size = str(params.size);
      return t`${name} lost its size setting (${size}).`;
    }
    case "settings_unreadable":
      return settingsSentence(finding.params);
    case "name_clash": {
      const original = str(params.original);
      return t`${original} was taken.`;
    }
    case "folder_note":
      return t`Moved into its matching folder.`;
    case "binary_extension": {
      const original = str(params.original);
      const type = str(params.type);
      return t`${original} is a ${type}.`;
    }
    case "zip": {
      const name = str(params.name);
      return t`${name} is a ZIP and was imported as a file. To import what's inside, unzip it and import the folder.`;
    }
    case "properties_unreadable":
      return t`Its properties couldn't be read, so they're shown as written.`;
    case "kept_as_text":
      return keptAsTextSentence(params);
    default:
      return unhandled(finding, t`Worth a look.`);
  }
}

/** Why a folder's Obsidian settings went unused; each reason says only what is known. */
function settingsSentence({ name, reason }: ImportFindingParams["settings_unreadable"]): string {
  switch (reason) {
    case "unavailable":
      return t`Your browser doesn't share hidden folders, so if ${name} has Obsidian settings, links and pictures were matched without them.`;
    case "unreadable":
      return t`${name}'s Obsidian settings couldn't be read, so links and pictures were matched without them.`;
    case "too_large":
      return t`${name}'s Obsidian settings are too large to read, so links and pictures were matched without them.`;
    case "malformed":
      return t`Meridian couldn't make sense of ${name}'s Obsidian settings, so links and pictures were matched without them.`;
    default:
      return unhandled(reason, t`${name}'s Obsidian settings weren't used.`);
  }
}

/** The "Kept as written" line for a document: "2 callouts and 5 tags". */
export function keptAsTextSentence(params: Params): string {
  const parts = [
    num(params.callouts) > 0
      ? plural(num(params.callouts), { one: "# callout", other: "# callouts" })
      : null,
    num(params.highlights) > 0
      ? plural(num(params.highlights), { one: "# highlight", other: "# highlights" })
      : null,
    num(params.tags) > 0 ? plural(num(params.tags), { one: "# tag", other: "# tags" }) : null,
    num(params.footnotes) > 0
      ? plural(num(params.footnotes), { one: "# footnote", other: "# footnotes" })
      : null,
  ].filter((part): part is string => part !== null);
  return new Intl.ListFormat(i18n.locale || "en", { style: "long", type: "conjunction" }).format(
    parts,
  );
}

export function groupTitle(group: FindingGroup): string {
  switch (group) {
    case "hidden":
      return t`Hidden notes now show in the text`;
    case "links":
      return t`Links to check`;
    case "pictures":
      return t`Pictures and embeds`;
    case "kept":
      return t`Kept as written`;
    case "settings":
      return t`Obsidian settings`;
    case "other":
      return t`Other things to check`;
    case "renamed":
      return t`Renamed`;
  }
}

/** The one-line explanation under a group's title, when it has one. */
export function groupNote(group: FindingGroup): string | null {
  switch (group) {
    case "hidden":
      return t`Obsidian hides %% notes %% and <!-- comments -->. In Meridian they're part of the text, so check them before you share.`;
    case "kept":
      return t`Callouts, highlights, tags and footnotes stay as plain text.`;
    default:
      return null;
  }
}

export type CountedSkip = Extract<ImportSkipReason, "trash" | "hidden" | "unreadable">;

export function skipLine(
  reason: CountedSkip | null,
  input: { name: string; count: number },
): string {
  switch (reason) {
    case "trash":
      return plural(input.count, {
        one: "# file in Obsidian's trash",
        other: "# files in Obsidian's trash",
      });
    case "hidden":
      return plural(input.count, { one: "# hidden file", other: "# hidden files" });
    case "unreadable":
      return plural(input.count, {
        one: "# file couldn't be read",
        other: "# files couldn't be read",
      });
    case null:
      return input.name;
    default:
      return unhandled(reason, input.name);
  }
}

/** The second half of a named skip ("Plot.canvas   Obsidian canvases and bases aren't imported."). */
export function skipNote(reason: ImportEntryReason | null): string | null {
  switch (reason) {
    case "obsidian_canvas":
      return t`Obsidian canvases and bases aren't imported.`;
    case "too_large":
      return t`It's over 50 MB.`;
    case "export_works":
      return t`Import a Work's Scratch folder on its own to bring it back.`;
    // Counted on their own line, whose words already say why.
    case "trash":
    case "hidden":
    case "unreadable":
    // Failure reasons belong to failed files, never to a skipped one.
    case "conversion_failed":
    case "upload_failed":
    case "changed_since_chosen":
    case "edited_before_arrival":
    case "deleted_before_arrival":
    case "folder_deleted":
    case "server_error":
    case null:
      return null;
    default:
      return unhandled(reason, null);
  }
}
