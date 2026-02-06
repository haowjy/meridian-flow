import { Loader2 } from "lucide-react";

export function ImportProgress() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      <Loader2 className="text-primary size-8 animate-spin" />
      <p className="text-muted-foreground text-sm">Importing documents...</p>
    </div>
  );
}
