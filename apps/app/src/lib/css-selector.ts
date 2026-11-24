export const escapeCssIdent: (value: string) => string =
  globalThis.CSS?.escape ?? ((value) => value.replace(/[^\w-]/g, (character) => `\\${character}`));
