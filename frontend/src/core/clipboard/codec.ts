import type { MeridianClipboardElement } from "@/core/lib/meridianClipboard";

/**
 * Extensible app-level inline clipboard element.
 */
export type ClipboardElement = {
  type: string;
};

export interface ClipboardPositionedElement<
  T extends ClipboardElement = ClipboardElement,
> {
  position: number;
  element: T;
}

export interface ClipboardParsedText<T extends ClipboardElement> {
  text: string;
  elements: ClipboardPositionedElement<T>[];
}

export interface ClipboardCodec<T extends ClipboardElement> {
  type: T["type"];
  toPlainText(el: T): string;
  fromPlainText?: (text: string) => ClipboardParsedText<T> | null;
  toMeridian?: (el: T) => MeridianClipboardElement;
  fromMeridian: (el: MeridianClipboardElement) => T | null;
}

/**
 * Global codec registry used by clipboard interop surfaces.
 * Register each element type once, then all surfaces can share conversion logic.
 */
export class ClipboardCodecRegistry {
  private readonly codecs = new Map<string, ClipboardCodec<ClipboardElement>>();

  register<T extends ClipboardElement>(codec: ClipboardCodec<T>): void {
    this.codecs.set(
      codec.type,
      codec as unknown as ClipboardCodec<ClipboardElement>,
    );
  }

  get<T extends ClipboardElement>(type: string): ClipboardCodec<T> | null {
    return (this.codecs.get(type) as ClipboardCodec<T> | undefined) ?? null;
  }

  list(): ClipboardCodec<ClipboardElement>[] {
    return Array.from(this.codecs.values());
  }
}

export const clipboardCodecRegistry = new ClipboardCodecRegistry();
