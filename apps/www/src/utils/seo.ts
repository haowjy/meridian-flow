export const seo = ({
  title,
  description,
  image,
}: {
  title: string;
  description: string;
  image: string;
}) => [
  { title },
  { name: "description", content: description },
  { name: "twitter:card", content: "summary_large_image" },
  { name: "twitter:title", content: title },
  { name: "twitter:description", content: description },
  { name: "twitter:image", content: image },
  { property: "og:type", content: "website" },
  { property: "og:title", content: title },
  { property: "og:description", content: description },
  { property: "og:image", content: image },
];
