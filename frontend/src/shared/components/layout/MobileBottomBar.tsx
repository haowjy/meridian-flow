import { MessageSquare, List, FileText, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUIStore, type MobileTab } from "@/core/stores/useUIStore";

interface MobileBottomBarProps {
  activeTab: MobileTab;
}

export function MobileBottomBar({ activeTab }: MobileBottomBarProps) {
  const setMobileActiveTab = useUIStore((s) => s.setMobileActiveTab);

  return (
    <nav
      className="bg-background flex items-center justify-around border-t md:hidden"
      style={{
        height: "calc(3.5rem + env(safe-area-inset-bottom))", // 56px base
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <button
        onClick={() => setMobileActiveTab("threads")}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-center px-4 transition-colors",
          activeTab === "threads" ? "text-primary" : "text-muted-foreground",
        )}
        aria-label="Threads"
        aria-current={activeTab === "threads" ? "page" : undefined}
      >
        <List className="size-4" />
      </button>

      <button
        onClick={() => setMobileActiveTab("chat")}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-center px-4 transition-colors",
          activeTab === "chat" ? "text-primary" : "text-muted-foreground",
        )}
        aria-label="Chat"
        aria-current={activeTab === "chat" ? "page" : undefined}
      >
        <MessageSquare className="size-4" />
      </button>

      <button
        onClick={() => setMobileActiveTab("documents")}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-center px-4 transition-colors",
          activeTab === "documents" ? "text-primary" : "text-muted-foreground",
        )}
        aria-label="Documents"
        aria-current={activeTab === "documents" ? "page" : undefined}
      >
        <FileText className="size-4" />
      </button>

      <button
        onClick={() => setMobileActiveTab("projectSettings")}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-center px-4 transition-colors",
          activeTab === "projectSettings"
            ? "text-primary"
            : "text-muted-foreground",
        )}
        aria-label="Settings"
        aria-current={activeTab === "projectSettings" ? "page" : undefined}
      >
        <Settings className="size-4" />
      </button>
    </nav>
  );
}

// Re-export MobileTab type for convenience
export type { MobileTab };
