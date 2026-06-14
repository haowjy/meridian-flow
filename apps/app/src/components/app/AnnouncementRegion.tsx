// @ts-nocheck
import { useAnnouncement } from "@/client/stores";

/**
 * Global screen-reader announcement region. Renders two `aria-live` zones:
 * - `polite` for informational updates (thread navigation, streaming status).
 * - `assertive` for errors that need immediate attention.
 *
 * Both are visually hidden but exposed to assistive tech. Mounted once near
 * `<body>` in `__root.tsx`.
 */
export function AnnouncementRegion() {
  const { current } = useAnnouncement();

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="visually-hidden">
        {current.polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="visually-hidden">
        {current.assertive}
      </div>
    </>
  );
}
