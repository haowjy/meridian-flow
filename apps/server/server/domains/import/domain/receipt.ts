/** Verified byte facts shared by upload receipts and organize inputs. */
import type { Filetype } from "@meridian/contracts/protocol";

export interface FileReceipt {
  objectKey: string;
  storageUrl: string;
  receivedSize: number;
  sha256: string;
  facts: {
    kind: "note" | "code" | "docx" | "binary";
    filetype: Filetype;
    mimeType: string;
    name: string;
    extension: string;
  };
  aliases: string[];
}
