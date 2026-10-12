// @vitest-environment jsdom
/** The note names the tab's title, has accessible dismissal, and wraps naturally. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DeletedChatNotice } from "./DeletedChatNotice";

it("renders titled singular, plural and untitled copy with a working Dismiss X", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let dismissed = "";
  const render = async (title: string | null, count: number) =>
    act(() =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(DeletedChatNotice, {
            notice: { threadId: "chat", title, count },
            onDismiss: () => {
              dismissed = "chat";
            },
          }),
        ),
      ),
    );
  try {
    await render("Arc 2 notes", 1);
    expect(host.textContent).toContain("Arc 2 notes was deleted. Your message is below.");
    expect(host.querySelector("strong")?.textContent).toBe("Arc 2 notes");
    await act(() => (host.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click());
    expect(dismissed).toBe("chat");
    await render("Arc 2 notes", 2);
    expect(host.textContent).toContain("Your messages are below.");
    await render(null, 1);
    expect(host.textContent).toContain("A chat you had open was deleted. Your message is below.");
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
