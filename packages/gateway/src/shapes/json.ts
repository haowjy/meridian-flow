/** JSON-natural value; the gateway's tool-result payloads and message metadata use it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
