import type { ReferenceElementData } from "@/features/threads/composer/inlineElements";
import { DocumentReferencePickerDropdown } from "./DocumentReferencePickerDropdown";

interface ComposerAddContextButtonProps {
  disabled?: boolean;
  onAddReferences: (refs: ReferenceElementData[]) => void;
}

export function ComposerAddContextButton({
  disabled,
  onAddReferences,
}: ComposerAddContextButtonProps) {
  return (
    <DocumentReferencePickerDropdown
      disabled={disabled}
      onAddReferences={onAddReferences}
    />
  );
}
