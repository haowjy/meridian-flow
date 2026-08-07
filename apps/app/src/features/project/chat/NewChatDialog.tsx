/** Work picker shown only while creating a chat. Existing chats never move Works. */
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
  const { works, currentWorkId } = useWorks(projectId);
  const { createChat, creating } = useCreateChat(projectId, (threadId) => {
    onOpenChange(false);
    onSelectThread(threadId);
  });
  const active = works?.filter((work) => work.status === "active") ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose a Work for this chat</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          {active.map((work) => (
            <Button
              key={work.id}
              variant={work.id === currentWorkId ? "default" : "outline"}
              className="h-auto justify-start py-3 text-left"
              disabled={creating}
              onClick={() => createChat(work.id)}
            >
              <span>
                <span className="block font-medium">{work.name}</span>
                <span className="block font-normal text-meta opacity-80">
                  {work.goal || "No goal yet"}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
