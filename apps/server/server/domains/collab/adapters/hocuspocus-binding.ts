/** The mutable Hocuspocus instance the collab domain binds once the gateway creates it. */
import type { Hocuspocus } from "@hocuspocus/server";

export function createHocuspocusBinding() {
  let instance: Hocuspocus | null = null;
  return {
    bind(hocuspocus: Hocuspocus): void {
      instance = hocuspocus;
    },
    current(): Hocuspocus | null {
      return instance;
    },
    require(): Hocuspocus {
      if (!instance) throw new Error("Hocuspocus is not bound to the collab domain");
      return instance;
    },
  };
}
