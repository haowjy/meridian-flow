/** The two items every "Import…" menu offers: pick a folder or pick files. The OS picker opens at once. */
import { Trans } from "@lingui/react/macro";
import { Files, Folder } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { PickKind } from "./ImportProvider";
import { canPickFolders } from "./SelectionPicker";

export function ImportMenuItems({ onPick }: { onPick: (kind: PickKind) => void }) {
  return (
    <>
      {canPickFolders() ? (
        <DropdownMenuItem onSelect={() => onPick("folder")}>
          <Folder className="size-3.5 text-muted-foreground" aria-hidden />
          <Trans>Folder…</Trans>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => onPick("files")}>
        <Files className="size-3.5 text-muted-foreground" aria-hidden />
        <Trans>Files…</Trans>
      </DropdownMenuItem>
    </>
  );
}
