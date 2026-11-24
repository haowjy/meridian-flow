import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

const NONE_MSG = msg`None`;

export type WorkNaming = { name: string; isNoWork?: boolean };

export function workDisplayName(work: WorkNaming): string {
  return work.isNoWork ? i18n._(NONE_MSG) : work.name;
}

export type WorkRef = { id: string; name: string; isNoWork?: boolean; projectId: string };

export type WorkHandleOf = (work: { id: string }) => string | null;

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

export const workNameWith =
  (handleOf: WorkHandleOf) =>
  (work: { id: string; name: string; isNoWork?: boolean }): string => {
    const name = workDisplayName({ name: work.name, isNoWork: work.isNoWork === true });
    const handle = handleOf(work);
    return handle ? `${name} ${handle}` : name;
  };
