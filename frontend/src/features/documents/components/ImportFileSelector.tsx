import { useRef, DragEvent, useState } from "react";
import { Upload, FolderOpen } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { DialogFooter } from "@/shared/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isFolderUploadSupported } from "../utils/importProcessing";

interface ImportFileSelectorProps {
  onFilesSelected: (files: FileList) => void;
  onCancel: () => void;
  error: string | null;
}

export function ImportFileSelector({
  onFilesSelected,
  onCancel,
  error,
}: ImportFileSelectorProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isFolderDragOver, setIsFolderDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const folderSupported = isFolderUploadSupported();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onFilesSelected(files);
    }
    // Reset input so same files can be selected again
    e.target.value = "";
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      onFilesSelected(files);
    }
  };

  const handleDropzoneClick = () => {
    fileInputRef.current?.click();
  };

  const handleChooseFolder = () => {
    folderInputRef.current?.click();
  };

  // Folder dropzone handlers
  const handleFolderDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsFolderDragOver(true);
  };

  const handleFolderDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsFolderDragOver(false);
  };

  const handleFolderDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsFolderDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      onFilesSelected(files);
    }
  };

  return (
    <>
      <div className="space-y-2">
        {/* Dropzone - clickable for files, drag for files/folders */}
        <div
          onClick={handleDropzoneClick}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg p-4 transition-colors",
            "border-2 border-dashed",
            isDragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 bg-muted/30 hover:border-muted-foreground/50 hover:bg-muted/50",
          )}
        >
          <div className="bg-muted rounded-full p-2">
            <Upload className="text-muted-foreground size-5" />
          </div>
          <p className="text-muted-foreground text-center text-sm">
            Click or drag files to import
          </p>
        </div>

        {/* Divider and folder dropzone */}
        {folderSupported && (
          <>
            <div className="flex items-center gap-3 py-1">
              <div className="bg-border h-px flex-1" />
              <span className="text-muted-foreground text-xs">or</span>
              <div className="bg-border h-px flex-1" />
            </div>

            <div
              onClick={handleChooseFolder}
              onDragOver={handleFolderDragOver}
              onDragLeave={handleFolderDragLeave}
              onDrop={handleFolderDrop}
              className={cn(
                "flex cursor-pointer items-center justify-center gap-2 rounded-lg p-3 transition-colors",
                "border-2 border-dashed",
                isFolderDragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 bg-muted/30 hover:border-muted-foreground/50 hover:bg-muted/50",
              )}
            >
              <FolderOpen className="text-muted-foreground size-4" />
              <p className="text-muted-foreground text-sm">
                Click or drag folder to import
              </p>
            </div>
          </>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,.md,.txt,.html"
          onChange={handleFileChange}
          multiple
          className="hidden"
        />

        {/* Hidden folder input (webkitdirectory) */}
        {folderSupported && (
          <input
            ref={folderInputRef}
            type="file"
            onChange={handleFileChange}
            // @ts-expect-error webkitdirectory is not in React types
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
          />
        )}

        {/* API error */}
        {error && (
          <div className="bg-destructive/10 border-destructive/20 rounded border px-3 py-2">
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}
