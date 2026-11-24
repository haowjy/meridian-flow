import { useAnnouncement } from "@/client/stores";

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
