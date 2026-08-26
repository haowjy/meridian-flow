/** Work creation and lifecycle dialog; each mount owns one open form session. */
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { useEffect, useRef, useState } from "react";
import type { useWorkMutations } from "@/client/query/useWorks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type WorkAction = Parameters<ReturnType<typeof useWorkMutations>["mutate"]>[0];

export function WorkDialog({
  work,
  pending,
  error,
  onClose,
  onAction,
}: {
  work: "new" | Work;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onAction: (action: WorkAction) => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const admitted = useRef(false);
  useEffect(() => {
    if (!pending) admitted.current = false;
  }, [pending]);
  const existing = work === "new" ? null : work;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {existing ? <Trans>Manage Work</Trans> : <Trans>New Work</Trans>}
          </DialogTitle>
        </DialogHeader>
        {existing ? (
          <p className="text-sm">
            {existing.status === "archived" ? (
              <Trans>This Work is archived.</Trans>
            ) : (
              <Trans>This Work is active.</Trans>
            )}
          </p>
        ) : (
          <>
            <label htmlFor="new-work-name" className="grid gap-1 text-sm">
              <Trans>Name</Trans>
              <Input
                id="new-work-name"
                autoFocus
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label htmlFor="new-work-goal" className="grid gap-1 text-sm">
              <Trans>Goal</Trans>
              <Input
                id="new-work-goal"
                value={goal}
                disabled={pending}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : null}
        <DialogFooter>
          {existing ? (
            <>
              <Button
                variant="outline"
                disabled={pending}
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={() => {
                  if (admitted.current) return;
                  admitted.current = true;
                  onAction({
                    type: existing.status === "archived" ? "unarchive" : "archive",
                    workId: existing.id,
                  });
                }}
              >
                {existing.status === "archived" ? (
                  <Trans>Unarchive Work</Trans>
                ) : (
                  <Trans>Archive Work</Trans>
                )}
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={() => {
                  if (admitted.current) return;
                  admitted.current = true;
                  onAction({ type: "delete", workId: existing.id });
                }}
              >
                <Trans>Delete Work</Trans>
              </Button>
            </>
          ) : (
            <Button
              disabled={pending || !name.trim()}
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={() => {
                if (admitted.current) return;
                admitted.current = true;
                onAction({ type: "create", data: { name, goal } });
              }}
            >
              <Trans>Create Work</Trans>
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={pending}
            onClick={onClose}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <Trans>Cancel</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
