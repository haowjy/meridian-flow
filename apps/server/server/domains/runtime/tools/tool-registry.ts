/** Name-keyed tool registrations; duplicate names are rejected and only advertised server tools are published. */
import type { FunctionTool } from "../gateway/index.js";

import type { ToolRegistration, ToolRegistry } from "./types.js";

export interface CreateToolRegistryOptions {
  registrations?: ToolRegistration[];
}

export function createToolRegistry(options: CreateToolRegistryOptions = {}): ToolRegistry {
  const registrations = new Map<string, ToolRegistration>();

  function addRegistration(registration: ToolRegistration): void {
    const name = registration.definition.name;
    if (registrations.has(name)) {
      throw new Error(`Tool registration already exists for name: ${name}`);
    }
    registrations.set(name, registration);
  }

  for (const registration of options.registrations ?? []) {
    addRegistration(registration);
  }

  return {
    register(registration: ToolRegistration): void {
      addRegistration(registration);
    },

    getDefinitions(): FunctionTool[] {
      return [...registrations.values()]
        .filter(
          (registration) =>
            registration.execution.type === "server" && registration.advertise !== false,
        )
        .map((registration) => registration.definition);
    },

    getRegistration(name: string): ToolRegistration | undefined {
      return registrations.get(name);
    },
  };
}
