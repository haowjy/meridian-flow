import { FileCard } from "@/components/app/FileCard";

export type BinaryFallbackViewerProps = {
  url: string;
  mimeType: string;
  name: string;
  sizeBytes: number | null;
};

export function BinaryFallbackViewer({
  url,
  mimeType,
  name,
  sizeBytes,
}: BinaryFallbackViewerProps) {
  return (
    <div className="grid h-full min-h-0 place-items-center px-6 py-10">
      <FileCard name={name} mimeType={mimeType} sizeBytes={sizeBytes} url={url} />
    </div>
  );
}
