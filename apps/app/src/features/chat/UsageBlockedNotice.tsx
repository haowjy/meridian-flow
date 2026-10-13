/** The inbox's saved usage block, with the existing Settings navigation. */
import { t } from "@lingui/core/macro";
import { NoticeCard } from "@/components/app/NoticeCard";
import { useSettingsNavigation } from "@/features/account/SettingsDialog";

export function UsageBlockedNotice() {
  const { open } = useSettingsNavigation();
  return (
    <NoticeCard tone="info">
      <p className="min-w-0 flex-1">{t`You're out of usage. Your messages will send when you add more.`}</p>
      <a
        href="?settings=usage"
        className="shrink-0 underline underline-offset-2"
        onClick={(event) => {
          event.preventDefault();
          open("usage");
        }}
      >{t`Add usage`}</a>
    </NoticeCard>
  );
}
