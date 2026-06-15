/** Ambient Nitro virtual modules used by package seeding in built server output. */
declare module "#nitro/virtual/server-assets" {
  export const assets: {
    getKeys(): Promise<string[]>;
    getItem(key: string): Promise<string>;
  };
}
