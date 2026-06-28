/**
 * Proto route — sticky thread-contents popover interactive demo.
 * Public, no auth. Disposable mockup at /proto/thread-info.
 */
import { createFileRoute } from "@tanstack/react-router";

import { ThreadInfoProtoShell } from "@/features/proto/thread-info/ThreadInfoProtoShell";

export const Route = createFileRoute("/proto/thread-info")({
  component: ThreadInfoProtoShell,
});
