/** Browser entry that mounts shipped project chat rows and loading rows with deterministic data. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { createRoot } from "react-dom/client";
import { ChatIndexLoading } from "../../src/features/project/chat-index/ChatIndex";
import { ProjectChatRow } from "../../src/features/project/chat-list/ProjectChatRow";
import "../../src/styles/globals.css";

const ordinary = Array.from(
  { length: 34 },
  (_, index): ProjectChatItem => ({
    id: `ordinary-${index + 1}`,
    title: `Recent Chapter ${index + 1}`,
    work: { id: `work-${index + 1}`, title: index % 2 ? "Arc Two" : "Arc One" },
    agentName: index % 2 ? "Writer" : "Muse",
    lastMessagePreview: "A normal preview remains readable beside its activity date.",
    lastActivityAt: "2026-08-24T12:00:00.000Z",
    actionRequired: false,
    isFavorite: false,
  }),
);
const longValue = "Long value ".repeat(20);
const long: ProjectChatItem = {
  ...ordinary[0],
  id: "long",
  title: longValue,
  work: { id: "work-long", title: longValue },
  agentName: longValue,
  lastMessagePreview: longValue,
};
const rowProps = {
  now: Date.parse("2026-08-25T12:00:00.000Z"),
  onOpen: () => undefined,
  onFavorite: () => undefined,
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
createRoot(root).render(
  <main className="project-screen-column">
    <section id="real-rows" className="-mx-2">
      {[...ordinary, long].map((item) => (
        <ProjectChatRow key={item.id} item={item} favorite={{ pending: false }} {...rowProps} />
      ))}
    </section>
    <section id="loading-rows">
      <ChatIndexLoading />
    </section>
  </main>,
);
