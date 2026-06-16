import { createFileRoute } from "@tanstack/react-router";

import { IndependentChatView } from "@/features/chat/IndependentChatView";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { threadId } = Route.useParams();
  return <IndependentChatView threadId={threadId} />;
}
