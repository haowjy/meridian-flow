/** Work picker shown only while creating a chat. Existing chats never move Works. */
import { Trans } from "@lingui/react/macro";
import { useWorks } from "@/client/query/useWorks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCreateChat } from "./use-create-chat";

export function NewChatDialog({
  projectId,
  open,
  onOpenChange,
  onSelectThread,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectThread: (threadId: string) => void;
}) {
  const { works, currentWorkId, isError, isFetching, refetch } = useWorks(projectId);
  const { createChat, creating, createError, resetCreateError } = useCreateChat(
    projectId,
    (threadId) => {
      onOpenChange(false);
      onSelectThread(threadId);
    },
  );
  const eligible =
    works?.filter((work) => work.status === "active" || work.id === currentWorkId) ?? [];
  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) resetCreateError();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent aria-busy={creating || isFetching}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Choose a Work for this chat</Trans>
          </DialogTitle>
        </DialogHeader>

        {isError ? (
          <div className="grid gap-3" role="alert">
            <p className="text-sm text-destructive">
              <Trans>Couldn't load Works.</Trans>
            </p>
            <Button variant="outline" onClick={refetch}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : works === null ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading Works…</Trans>
          </p>
        ) : eligible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No Work is available for a new chat.</Trans>
          </p>
        ) : (
          <div className="grid gap-2">
            {eligible.map((work) => (
              <Button
                key={work.id}
                variant={work.id === currentWorkId ? "default" : "outline"}
                className="h-auto justify-start py-3 text-left"
                disabled={creating}
                onClick={() => createChat(work.id)}
              >
                <span>
                  <span className="block font-medium">{work.name}</span>
                  {work.id === currentWorkId ? (
                    <span className="sr-only">
                      <Trans>Current Work</Trans>
                    </span>
                  ) : null}
                  <span className="block font-normal text-meta opacity-80">
                    {work.goal || <Trans>No goal yet</Trans>}
                  </span>
                  {work.status === "archived" ? (
                    <span className="block font-normal text-meta opacity-80">
                      <Trans>Archived current Work</Trans>
                    </span>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
        )}

        {createError ? (
          <p className="text-sm text-destructive" role="alert">
            {createError.message}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
