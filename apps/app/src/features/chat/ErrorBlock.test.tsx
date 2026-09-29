import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));

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

  it("offers Retry beside a failed reply, and waits with a true note while the chat is busy", () => {
    const idle = renderToStaticMarkup(<ErrorBlock isLatest onRetry={() => undefined} />);
    expect(idle).toMatch(/This response failed\.<\/p><button[^>]*data-reply-retry/);
    expect(idle).not.toContain("aria-disabled=");
    expect(idle).not.toContain("You can retry when this chat is free.");

    const busy = renderToStaticMarkup(
      <ErrorBlock isLatest onRetry={() => undefined} retryWaiting />,
    );
    const describedBy = busy.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).toContain(`id="${describedBy}"`);
    expect(busy).toContain("You can retry when this chat is free.");
  });

  it("notes a refused Retry, current or in history", () => {
    const refused = "Couldn&#x27;t retry. Something else started in this chat first.";
    expect(
      renderToStaticMarkup(<ErrorBlock isLatest onRetry={() => undefined} retryRefused />),
    ).toContain(refused);
    const historical = renderToStaticMarkup(<ErrorBlock isLatest={false} retryRefused />);
    expect(historical).toContain(refused);
    expect(historical).not.toContain('role="alert"');
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
