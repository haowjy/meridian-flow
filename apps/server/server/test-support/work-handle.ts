import { decodeWorkHandle, type WorkHandle } from "@meridian/contracts/works";

export function testWorkHandle(value: string): WorkHandle {
  const decoded = decodeWorkHandle(value);
  if (!decoded) throw new Error(`Invalid Work handle fixture: ${value}`);
  return decoded;
}
