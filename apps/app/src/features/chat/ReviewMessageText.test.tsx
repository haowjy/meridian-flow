// @vitest-environment jsdom
/** The words for a held failure: the connection is blamed only when the request never arrived. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { describe, expect, it } from "vitest";

import type { DraftCommandFailure } from "@/client/query/draft-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewMessageText } from "./ReviewMessageText";

function textOf(failure: DraftCommandFailure): Promise<string> {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  let text = "";
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <p data-probe>
        <ReviewMessageText failure={failure} />
      </p>
    </I18nProvider>,
    async () => {
      text = document.querySelector("[data-probe]")?.textContent ?? "";
    },
  ).then(() => text);
}

describe("ReviewMessageText", () => {
  it.each([
    [{ code: "apply-offline" }, "Couldn't apply. Check your connection and try again."],
    [{ code: "discard-offline" }, "Couldn't discard. Check your connection and try again."],
    [
      { code: "apply-refused", reason: "This Work is archived and read-only." },
      "Couldn't apply this draft. This Work is archived and read-only.",
    ],
    [{ code: "discard-refused", reason: "Nope" }, "Couldn't discard this draft. Nope."],
    [{ code: "apply-refused" }, "Couldn't apply this draft."],
    [{ code: "apply-server-error" }, "Couldn't apply this draft. Try again."],
    [{ code: "discard-server-error" }, "Couldn't discard this draft. Try again."],
  ] as const)("%j reads %s", async (failure, expected) => {
    expect(await textOf(failure)).toBe(expected);
  });
});
