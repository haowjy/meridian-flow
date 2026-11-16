/** Request parsing and error mapping for the MCP connections routes. */
import type {
  McpAddConnectionRequest,
  McpEditConnectionRequest,
  McpPinRequest,
} from "@meridian/contracts/mcp";
import { createError } from "nitro/h3";
import { McpConnectionError } from "../domains/mcp/index.js";
import { requireRequestId } from "./request-id.js";

const STATUS: Record<McpConnectionError["code"], number> = {
  invalid: 400,
  not_found: 404,
  not_listed: 422,
  not_read_only: 422,
};

const bodyObject = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  return raw as Record<string, unknown>;
};

const optionalString = (body: Record<string, unknown>, field: string): string | undefined => {
  const value = body[field];
  if (value !== undefined && typeof value !== "string")
    throw createError({ statusCode: 400, message: `\`${field}\` must be a string` });
  return value;
};

export function parseAddConnection(raw: unknown): McpAddConnectionRequest {
  const body = bodyObject(raw);
  const name = optionalString(body, "name");
  const url = optionalString(body, "url");
  if (name === undefined || url === undefined)
    throw createError({ statusCode: 400, message: "`name` and `url` are required" });
  return {
    name,
    url,
    token: optionalString(body, "token"),
    projectId:
      body.projectId === undefined ? undefined : requireRequestId(body.projectId, "projectId"),
  };
}

export function parseEditConnection(raw: unknown): McpEditConnectionRequest {
  const body = bodyObject(raw);
  return { url: optionalString(body, "url"), token: optionalString(body, "token") };
}

export function parsePinRequest(raw: unknown): McpPinRequest {
  const { tools } = bodyObject(raw);
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))
    throw createError({ statusCode: 400, message: "`tools` must be a list of tool names" });
  return { tools };
}

/** Runs a connection operation and turns its refusals into HTTP errors worded for the writer. */
export async function connectionOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpConnectionError)
      throw createError({ statusCode: STATUS[error.code], message: error.message });
    throw error;
  }
}
