import { BinaryFallbackViewer } from "./BinaryFallbackViewer";

export type PdfViewerProps = {
  url: string;
  downloadUrl: string;
  name: string;
  sizeBytes: number | null;
};

export function PdfViewer({ url, downloadUrl, name, sizeBytes }: PdfViewerProps) {
  return (
    <object data={url} type="application/pdf" aria-label={name} className="h-full w-full">
      <BinaryFallbackViewer
        url={downloadUrl}
        mimeType="application/pdf"
        name={name}
        sizeBytes={sizeBytes}
      />
    </object>
  );
}
