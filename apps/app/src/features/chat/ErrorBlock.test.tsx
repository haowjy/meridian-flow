import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorBlock } from "./ErrorBlock";

describe("ErrorBlock", () => {
  it("shows couldn't send and Retry on a failed first send", () => {
    const html = renderToStaticMarkup(
      <ErrorBlock isLatest kind="send" onRetry={() => undefined} />,
    );

    expect(html).toContain("Couldn&#x27;t send.");
    expect(html).toContain("Retry");
    expect(html).toContain("<button");
    expect(html).not.toContain("This response failed.");
  });

  it("shows generation-failure copy without Retry when nothing can be resubmitted", () => {
    const html = renderToStaticMarkup(<ErrorBlock isLatest />);

    expect(html).toContain("This response failed.");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("<button");
  });

  it("keeps historical errors quiet, one sentence per kind", () => {
    const generation = renderToStaticMarkup(<ErrorBlock isLatest={false} />);
    expect(generation).toContain("This response failed.");
    expect(generation).not.toContain('role="alert"');

    const send = renderToStaticMarkup(<ErrorBlock isLatest={false} kind="send" />);
    expect(send).toContain("Couldn&#x27;t send.");
    expect(send).not.toContain("This response failed.");
  });

  it("offers Retry beside a failed reply", () => {
    const html = renderToStaticMarkup(<ErrorBlock isLatest onRetry={() => undefined} />);
    expect(html).toMatch(/This response failed\.<\/p><button[^>]*data-reply-retry/);
    expect(html).not.toContain("aria-disabled=");
  });

  it("notes a refused Retry only while the error is current", () => {
    const refused = "Couldn&#x27;t retry.</p>";
    expect(
      renderToStaticMarkup(<ErrorBlock isLatest onRetry={() => undefined} retryRefused />),
    ).toContain(refused);
    const historical = renderToStaticMarkup(<ErrorBlock isLatest={false} retryRefused />);
    expect(historical).not.toContain(refused);
    expect(historical).not.toContain('role="alert"');
  });

  it("says the provider declined; history keeps the first sentence", () => {
    const current = renderToStaticMarkup(<ErrorBlock isLatest kind="provider-declined" />);
    expect(current).toContain(
      "The AI provider turned this request down. Trying again won&#x27;t help until that&#x27;s fixed.",
    );
    expect(current).not.toContain("<button");
    const historical = renderToStaticMarkup(
      <ErrorBlock isLatest={false} kind="provider-declined" />,
    );
    expect(historical).toContain("The AI provider turned this request down.");
    expect(historical).not.toContain("Trying again");
  });

  it("says a lost Retry never started, with Retry while it is current", () => {
    const current = renderToStaticMarkup(
      <ErrorBlock isLatest kind="retry" onRetry={() => undefined} />,
    );
    expect(current).toContain("Couldn&#x27;t start the retry. Try again.");
    expect(current).toContain("Retry");
    const historical = renderToStaticMarkup(<ErrorBlock isLatest={false} kind="retry" />);
    expect(historical).toContain("Couldn&#x27;t start the retry.");
    expect(historical).not.toContain("Try again.");
  });
});
