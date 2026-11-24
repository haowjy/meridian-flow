import { parseTokenKey } from "../domains/mcp/index.js";

// keep: public on purpose: it protects nothing, and the startup guard refuses it outside dev
export const DEV_MCP_TOKEN_KEY = Buffer.alloc(32, "meridian-dev-mcp-token-key").toString("base64");

export function resolveMcpTokenKey(environment: NodeJS.ProcessEnv): Buffer {
  const raw = environment.MCP_TOKEN_KEY?.trim();
  if (raw) return parseTokenKey(raw);
  if (environment.NODE_ENV === "production")
    throw new Error("MCP_TOKEN_KEY is required in production");
  return parseTokenKey(DEV_MCP_TOKEN_KEY);
}
