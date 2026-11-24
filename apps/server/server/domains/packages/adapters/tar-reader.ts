import { PackageFetchError } from "../ports/package-fetcher.js";

export type TarEntry = {
  name: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  body(): Promise<Buffer>;
  skip(): Promise<void>;
};

const BLOCK = 512;
const EMPTY = Buffer.alloc(0);
const MAX_META_BYTES = 1024 * 1024;

const corrupt = (why: string) => new PackageFetchError("upstream", `Archive is corrupt: ${why}`);

class ByteReader {
  private current: Buffer = EMPTY;
  private readonly source: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.source = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    const next = await this.source.next();
    if (next.done) return false;
    this.current = next.value;
    return true;
  }

  async read(length: number): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    let need = length;
    while (need > 0) {
      if (this.current.length === 0 && !(await this.fill())) {
        if (need === length) return null;
        throw corrupt("it ends inside an entry");
      }
      const taken = this.current.subarray(0, need);
      this.current = this.current.subarray(taken.length);
      parts.push(taken);
      need -= taken.length;
    }
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }

  async skip(length: number): Promise<void> {
    let need = length;
    while (need > 0) {
      if (this.current.length === 0 && !(await this.fill()))
        throw corrupt("it ends inside an entry");
      const taken = Math.min(need, this.current.length);
      this.current = this.current.subarray(taken);
      need -= taken;
    }
  }

  async drain(): Promise<void> {
    while (await this.fill());
    this.current = EMPTY;
  }
}

async function mustRead(reader: ByteReader, length: number): Promise<Buffer> {
  const data = await reader.read(length);
  if (data === null) throw corrupt("it ends inside an entry");
  return data;
}

function text(field: Buffer): string {
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end === -1 ? field.length : end);
}

function octalOrBinary(field: Buffer): number {
  if ((field[0] as number) & 0x80) {
    let value = (field[0] as number) & 0x7f;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + (field[i] as number);
    return value;
  }
  const digits = text(field).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw corrupt("a size field is not a number");
  return Number.parseInt(digits, 8);
}

function checksumMatches(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : (header[i] as number);
  return sum === octalOrBinary(header.subarray(148, 156));
}

function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number.parseInt(data.toString("utf8", at, space), 10);
    if (space === -1 || !(length > space - at) || at + length > data.length) {
      throw corrupt("a pax header is malformed");
    }
    const record = data.toString("utf8", space + 1, at + length - 1);
    const eq = record.indexOf("=");
    if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return records;
}

function entryType(flag: string): TarEntry["type"] {
  if (flag === "0" || flag === "\0" || flag === "7") return "file";
  if (flag === "5") return "directory";
  if (flag === "1" || flag === "2") return "link";
  return "other";
}

export async function readTar(
  source: AsyncIterable<Buffer>,
  onEntry: (entry: TarEntry) => Promise<void>,
): Promise<void> {
  const reader = new ByteReader(source);
  let nextName: string | undefined;
  let nextSize: number | undefined;
  for (;;) {
    const header = await reader.read(BLOCK);
    if (header === null || header.every((byte) => byte === 0)) break;
    if (!checksumMatches(header)) throw corrupt("a header checksum is wrong");

    const flag = String.fromCharCode(header[156] as number);
    const prefix = text(header.subarray(345, 500));
    let name = text(header.subarray(0, 100));
    if (prefix && header.toString("latin1", 257, 262) === "ustar") name = `${prefix}/${name}`;
    let size = octalOrBinary(header.subarray(124, 136));
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
      if (size > MAX_META_BYTES) throw corrupt("a metadata header is too large");
      const data = padded === 0 ? EMPTY : await mustRead(reader, padded);
      const content = data.subarray(0, size);
      if (flag === "x") {
        const records = parsePax(content);
        nextName = records.get("path") ?? nextName;
        const paxSize = records.get("size");
        if (paxSize !== undefined) nextSize = Number.parseInt(paxSize, 10);
      } else if (flag === "L") {
        nextName = text(content);
      }
      continue;
    }

    name = nextName ?? name;
    size = nextSize ?? size;
    nextName = undefined;
    nextSize = undefined;
    if (!Number.isSafeInteger(size) || size < 0) throw corrupt("a size is invalid");

    const type = entryType(flag);
    // keep: Tar links and directories carry no body; do not advance the reader by their size field
    const bodyBytes = type === "file" || type === "other" ? size : 0;
    const bodyPadded = Math.ceil(bodyBytes / BLOCK) * BLOCK;
    let consumed = false;
    const consume = () => {
      if (consumed) throw new Error("Tar entry consumed twice");
      consumed = true;
    };
    await onEntry({
      name,
      type,
      size: bodyBytes,
      async body() {
        consume();
        const data = bodyBytes === 0 ? EMPTY : await mustRead(reader, bodyPadded);
        return Buffer.from(data.subarray(0, bodyBytes));
      },
      async skip() {
        consume();
        await reader.skip(bodyPadded);
      },
    });
    if (!consumed) throw new Error("Tar entry was not consumed");
  }
  await reader.drain();
}
