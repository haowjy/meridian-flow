import { Button } from "./ui/button";
import { AlertCircle } from "lucide-react";

interface ErrorPanelProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorPanel({
  title = "Something went wrong",
  message,
  onRetry,
}: ErrorPanelProps) {
  return (
    <div
      className="border-error/50 bg-error/10 flex min-h-[400px] flex-col items-center justify-center rounded-lg border p-8 text-center"
      role="alert"
    >
      <AlertCircle className="text-error mb-4 h-12 w-12" />
      <h3 className="type-section mb-2">{title}</h3>
      <p className="type-body text-muted-foreground mb-4">{message}</p>
      {onRetry && <Button onClick={onRetry}>Retry</Button>}
    </div>
  );
}
