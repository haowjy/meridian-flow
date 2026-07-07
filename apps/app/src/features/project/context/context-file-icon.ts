/**
 * Maps a context file name to a monochrome kind glyph (rendered at
 * `text-muted-foreground` by the call site). Deliberately mono — tinted
 * per-kind icons were tried in the tree redesign and dropped: the tint was
 * indistinguishable at icon size and read as generic-IDE noise. The glyph
 * *shape* carries the kind; color stays calm.
 */
import type { LucideIcon } from "lucide-react";
import { FileCode, FileImage, FileText, FileType } from "lucide-react";

export function fileKindIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(lower)) return FileImage;
  if (/\.pdf$/.test(lower)) return FileType;
  if (/\.(html?|css|jsx?|tsx?|json|ya?ml|toml)$/.test(lower)) return FileCode;
  // Markdown and everything else read as prose/document.
  return FileText;
}
