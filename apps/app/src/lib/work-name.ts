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
