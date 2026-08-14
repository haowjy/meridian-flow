/** Reusable Home collection structure and its container-responsive card grid. */
import type { HomeChatItem } from "@meridian/contracts/protocol";
import { HomeChatCard, type HomeChatCardProps } from "./HomeChatCard";

export function HomeFeedSection({
  title,
  items,
  cardProps,
}: {
  title: string;
  items: HomeChatItem[];
  cardProps: Omit<HomeChatCardProps, "item" | "variant">;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-headline-section">{title}</h2>
      <ul className="grid grid-cols-1 gap-4 @2xl/project-home:grid-cols-2">
        {items.map((item) => (
          <li key={item.id}>
            <HomeChatCard item={item} {...cardProps} />
          </li>
        ))}
      </ul>
    </section>
  );
}
