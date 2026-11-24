import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface TokenCipher {
  seal(token: string, owner: { connectionId: string; accountId: string }): string;
  open(sealed: string, owner: { connectionId: string; accountId: string }): string;
}

const VERSION = "v1";

export function parseTokenKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error("MCP_TOKEN_KEY must be 32 bytes, base64 encoded");
  return key;
}

export function createTokenCipher(key: Buffer): TokenCipher {
  const aad = (owner: { connectionId: string; accountId: string }) =>
    Buffer.from(`${owner.connectionId}:${owner.accountId}`);
  return {
    seal(token, owner) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(owner));
      const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), body]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },
    open(sealed, owner) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== VERSION || !iv || !tag || body === undefined)
        throw new Error("Unknown token format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), {
        authTagLength: 16,
      });
      decipher.setAAD(aad(owner));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
