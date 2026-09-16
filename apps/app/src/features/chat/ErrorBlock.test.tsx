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
    expect(html).not.toContain("Something went wrong generating a response.");
  });

  it("shows generation-failure copy without Retry when nothing can be resubmitted", () => {
    const html = renderToStaticMarkup(<ErrorBlock isLatest />);

    expect(html).toContain("Something went wrong generating a response.");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("<button");
  });

  it("keeps historical errors quiet", () => {
    const html = renderToStaticMarkup(<ErrorBlock isLatest={false} />);

    expect(html).toContain("Errored.");
    expect(html).not.toContain('role="alert"');
  });
});
