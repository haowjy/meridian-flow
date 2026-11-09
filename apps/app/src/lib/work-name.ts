import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

const NONE_MSG = msg`None`;

/**
 * A Work's name as the writer reads it. The project's No Work row keeps its
 * internal name in code, the KB and model-facing addresses; writers see "None".
 */
export function workDisplayName(work: { name: string; isNoWork: boolean }): string {
  return work.isNoWork ? i18n._(NONE_MSG) : work.name;
}
