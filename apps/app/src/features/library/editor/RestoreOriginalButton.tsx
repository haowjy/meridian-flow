// @ts-nocheck
/**
 * RestoreOriginalButton — shared "Restore original" affordance for definition editors
 * and package update reconciliation (one vocabulary per design 2C / 2F).
 */
import { Trans } from "@lingui/react/macro";
import { useState } from "react";

import { RestoreOriginalDialog } from "./RestoreOriginalDialog";

export function RestoreOriginalButton({
  disabled,
  pending,
  onConfirm,
}: {
  disabled?: boolean;
  pending: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => setOpen(true)}
        className="focus-ring rounded-md px-2 py-1 text-meta font-medium text-muted-foreground hover:bg-surface-subtle hover:text-foreground disabled:opacity-50"
      >
        <Trans>Restore original</Trans>
      </button>
      <RestoreOriginalDialog
        open={open}
        pending={pending}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          void Promise.resolve(onConfirm()).finally(() => setOpen(false));
        }}
      />
    </>
  );
}
