// @vitest-environment jsdom
/** A refusal always gives the writer a reason, in catalog words for the codes the review can meet. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReviewMessageText } from "./ReviewMessageText";

const text = (failure: Parameters<typeof ReviewMessageText>[0]["failure"]) => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <ReviewMessageText failure={failure} />
    </I18nProvider>,
  );
};

it("shows why an item was held or refused, and never nothing for an unknown code", () => {
  expect(text({ code: "apply-refused", serverCode: "path_taken" })).toContain(
    "already at this name",
  );
  expect(text({ code: "apply-refused", serverCode: "stale" })).toContain(
    "changed since you opened",
  );
  expect(text({ code: "apply-refused", serverCode: "brand_new_code" })).toMatch(
    /The server couldn.+t do that/,
  );
  // A removed document can't take the draft: the record says who, and nothing offers a retry.
  const deleted = text({
    code: "apply-refused",
    serverCode: "deleted_live",
    removal: {
      reason: "deleted",
      actor: { kind: "user", userId: "u2", displayName: "Ana" },
      time: "",
    },
  });
  expect(deleted).toMatch(/This document was deleted by Ana, so this draft can.+t be applied\./);
  expect(deleted).not.toMatch(/apply again|Couldn.+t apply/);
});
