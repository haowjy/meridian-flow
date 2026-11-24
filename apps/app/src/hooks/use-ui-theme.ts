import { useSyncExternalStore } from "react";

import { DEFAULT_UI_THEME, resolveUiTheme, subscribeUiTheme } from "@/lib/ui-theme";

export function useUiTheme() {
  return useSyncExternalStore(subscribeUiTheme, resolveUiTheme, () => DEFAULT_UI_THEME);
}
