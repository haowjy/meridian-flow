export type ContextPort = {
  readonly phase: "skeleton";
};

export type ContextPortFactory = {
  forThread(_threadId: string): ContextPort;
};

export function createInMemoryContextPortFactory(): ContextPortFactory {
  return {
    forThread() {
      return { phase: "skeleton" };
    },
  };
}

export function createProductionContextPortFactory(_db: unknown): ContextPortFactory {
  return createInMemoryContextPortFactory();
}
