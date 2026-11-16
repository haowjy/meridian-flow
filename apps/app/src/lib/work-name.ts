import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

const NONE_MSG = msg`None`;

export type WorkNaming = { name: string; isNoWork: boolean };

/**
 * A Work's name as the writer reads it. The project's No Work row keeps its
 * internal name in code, the KB and model-facing addresses; writers see "None"
 * wherever a Work is a value (pickers, chips, announcements). A list heading that
 * groups chats with no Work says "Chats without a Work": it names the group, not a value.
 */
export function workDisplayName(work: WorkNaming): string {
  return work.isNoWork ? i18n._(NONE_MSG) : work.name;
}

/** The handle a Work's name needs beside it, or null when its name is its own. */
export type WorkHandleOf = (work: { id: string }) => string | null;

/**
 * Two Works may share a name: wherever one is named, its handle (`w3`, the one
 * `scratch://@w3` uses) shows beside a name another Work in the project also has,
 * deleted Works included, so the writer can tell them apart. A name no other Work
 * has shows alone.
 */
export function repeatedNameHandles(
  works: readonly { id: string; name: string; handle: string | null }[],
): WorkHandleOf {
  const key = (name: string) => name.trim().toLocaleLowerCase();
  const seen = new Map<string, number>();
  for (const work of works)
    if (work.handle) seen.set(key(work.name), (seen.get(key(work.name)) ?? 0) + 1);
  const handles = new Map<string, string>();
  for (const work of works)
    if (work.handle && (seen.get(key(work.name)) ?? 0) > 1) handles.set(work.id, work.handle);
  return (work) => handles.get(work.id) ?? null;
}
