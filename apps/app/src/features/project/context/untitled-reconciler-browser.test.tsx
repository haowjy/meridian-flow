/** SSR contracts for the browser-owned untitled reconciler bindings. */

import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useQueuedIdentityFailure,
  useUntitledPending,
  useUntitledPendingSince,
} from "./untitled-reconciler-browser";

afterEach(() => vi.unstubAllGlobals());

describe("untitled reconciler browser bindings", () => {
  it("renders server-side without constructing the browser service", () => {
    vi.stubGlobal("window", undefined);

    function Probe() {
      const pending = useUntitledPending("doc-1");
      const pendingSince = useUntitledPendingSince("doc-1");
      const failure = useQueuedIdentityFailure("doc-1");
      return <span>{JSON.stringify({ pending, pendingSince, failure })}</span>;
    }

    expect(renderToString(<Probe />)).toContain("pending&quot;:false");
  });
});
