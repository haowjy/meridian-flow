// @vitest-environment jsdom
/** The words for a held failure: the connection is blamed only when the request never arrived. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { DraftCommandFailure } from "@/client/query/draft-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewMessageText } from "./ReviewMessageText";

describe("a held refusal across a language switch", () => {
  // The macros are stubbed in tests, so a message's id is its English text.
  const archivedEn = "This Work is archived. Unarchive it to apply or discard its changes.";
  const archivedZh = "此作品已归档。取消归档后才能应用或放弃其中的改动。";

  function renderHeld(failure: DraftCommandFailure, run: () => Promise<void>): Promise<void> {
    i18n.load("zh", { [archivedEn]: archivedZh });
    i18n.loadAndActivate({ locale: "en", messages: {} });
    return withReactRoot(
      <I18nProvider i18n={i18n}>
        <p data-probe>
          <ReviewMessageText failure={failure} />
        </p>
      </I18nProvider>,
      run,
    );
  }
  const text = () => document.querySelector("[data-probe]")?.textContent ?? "";

  it("is worded in the language it is shown in, from the server's code", async () => {
    await renderHeld(
      { code: "apply-refused", serverCode: "work_archived", serverReason: "Work is archived." },
      async () => {
        expect(text()).toBe(`Couldn't apply this draft. ${archivedEn}`);
        await act(async () => i18n.activate("zh"));
        expect(text()).toContain(archivedZh);
        expect(text()).not.toContain("Work is archived.");
        await act(async () => i18n.activate("en"));
        expect(text()).toBe(`Couldn't apply this draft. ${archivedEn}`);
      },
    );
  });

  it("keeps the server's own words for a code it has none for, in any language", async () => {
    await renderHeld(
      { code: "discard-refused", serverCode: "quota_exceeded", serverReason: "Quota exceeded." },
      async () => {
        await act(async () => i18n.activate("zh"));
        expect(text()).toContain("Quota exceeded.");
      },
    );
  });
});
