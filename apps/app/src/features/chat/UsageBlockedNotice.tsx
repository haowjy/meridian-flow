/** The inbox's saved usage block, with the existing Settings navigation. */
import { t } from "@lingui/core/macro";
import { NoticeCard } from "@/components/app/NoticeCard";
import { Button } from "@/components/ui/button";
import { useSettingsNavigation } from "@/features/account/SettingsDialog";

export function UsageBlockedNotice() {
  const { open } = useSettingsNavigation();
  return (
    <NoticeCard tone="error">
      <p className="min-w-0 flex-1">{t`You're out of usage. Your messages will send when you add more.`}</p>
      <Button type="button" variant="outline" size="xs" onClick={() => open("usage")}>
        {t`Add usage`}
      </Button>
    </NoticeCard>
  );
}
