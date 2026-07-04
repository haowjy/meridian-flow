/**
 * RestoreOriginalButton — shared "Restore original" affordance for definition editors
 * and package update reconciliation (one vocabulary per design 2C / 2F).
 */
import { Trans } from "@lingui/react/macro";
import { useState } from "react";

import { Button } from "@/components/ui/button";

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
      <Button
        type="button"
        variant="quiet"
        size="meta"
        disabled={disabled || pending}
        onClick={() => setOpen(true)}
      >
        <Trans>Restore original</Trans>
      </Button>
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
