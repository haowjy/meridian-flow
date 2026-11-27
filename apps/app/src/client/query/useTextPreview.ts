import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/client/api/http-client";

export type TextPreviewSource = { content: string } | { url: string };

type TextPreviewStatus =
  | { status: "ready"; text: string }
  | { status: "loading" }
  | { status: "error" };

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await apiFetch(url, { signal });
  if (!response.ok) throw new Error("Text preview request failed");
  return response.text();
}

export function useTextPreview(source: TextPreviewSource): TextPreviewStatus {
  const url = "url" in source ? source.url : null;
  const query = useQuery({
    queryKey: ["context-text-preview", url],
    queryFn: ({ signal }) => {
      if (url === null) throw new Error("A text preview URL is required");
      return fetchText(url, signal);
    },
    enabled: url !== null,
    staleTime: 60_000,
    retry: 0,
  });

  if ("content" in source) return { status: "ready", text: source.content };
  if (query.isError) return { status: "error" };
  if (query.data !== undefined) return { status: "ready", text: query.data };
  return { status: "loading" };
}
