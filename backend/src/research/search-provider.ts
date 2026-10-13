import { boundedText } from "../http/bounded-text.ts";

export interface SearchEnv {
  DOUBAO_SEARCH_API_KEY?: string;
}
export class SearchError extends Error {
  code: string;
  constructor(code: string) {
    super("Search request could not be completed");
    this.code = code;
  }
}
export interface SearchSource {
  source_id: string;
  title: string;
  url: string;
  snippet: string;
  content: string;
  content_kind: "provider_content" | "provider_summary" | "snippet_only";
  published_at: string | null;
  verification_status: "unverified";
}
export interface SearchProvider {
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<{
    provider: "doubao-custom";
    provider_request_id: string;
    searched_at: number;
    sources: SearchSource[];
  }>;
}
export function searchQuery(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value.trim()].length > 100 ||
    /[\p{Cc}\p{Cf}]|@|https?:|\d{7,}/u.test(value)
  )
    throw new SearchError("SEARCH_QUERY_REJECTED");
  return value.trim();
}
const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

// Display-only URLs. These are never fetched by the search adapter.
function resultUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !url.hostname.includes(".") ||
      /[\p{Cc}\p{Cf}\s\\]/u.test(value) ||
      /^[\d.]+$/.test(url.hostname) ||
      url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.startsWith("[")
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function doubaoSearchProvider(
  env: SearchEnv,
  fetcher: typeof fetch = (...args) => fetch(...args),
): SearchProvider {
  return {
    async search(raw, signal) {
      const query = searchQuery(raw);
      if (!env.DOUBAO_SEARCH_API_KEY?.trim())
        throw new SearchError("SEARCH_NOT_CONFIGURED");
      try {
        const response = await fetcher(
          "https://open.feedcoopapi.com/search_api/web_search",
          {
            method: "POST",
            redirect: "manual",
            signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.DOUBAO_SEARCH_API_KEY}`,
            },
            body: JSON.stringify({
              Query: query,
              SearchType: "web",
              Count: 5,
              EnableWaiting: false,
              ContentFormats: "text",
              Filter: { NeedUrl: true, NeedContent: false },
              QueryControl: { QueryRewrite: false },
            }),
          },
        );
        if (!response.ok)
          throw new SearchError(
            response.status === 429
              ? "SEARCH_RATE_LIMITED"
              : [401, 403].includes(response.status)
                ? "SEARCH_ACCESS_DENIED"
                : "SEARCH_UPSTREAM_ERROR",
          );
        if (
          !response.headers
            .get("Content-Type")
            ?.split(";")[0]
            .trim()
            .endsWith("json")
        )
          throw new SearchError("SEARCH_INVALID_RESPONSE");
        const body = JSON.parse(await boundedText(response.body, 262144));
        if (body?.ResponseMetadata?.Error) {
          const code = String(body.ResponseMetadata.Error.Code);
          throw new SearchError(
            ["10406", "10410", "10412"].includes(code)
              ? "SEARCH_QUOTA_EXHAUSTED"
              : code === "700429"
                ? "SEARCH_RATE_LIMITED"
                : "SEARCH_UPSTREAM_ERROR",
          );
        }
        const requestId = body?.ResponseMetadata?.RequestId;
        const items =
          body?.Result?.WebResults ??
          (body?.Result?.ResultCount === 0 ? [] : null);
        if (
          typeof requestId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ||
          !Array.isArray(items) ||
          items.length > 50
        )
          throw new SearchError("SEARCH_INVALID_RESPONSE");
        const sources: SearchSource[] = [];
        const urls = new Set<string>();
        for (const item of items) {
          const url = resultUrl(item?.Url);
          const title = text(item?.Title, 160);
          if (!url || !title || urls.has(url)) continue;
          urls.add(url);
          const summary = text(item.Summary, 1200);
          const content = text(item.Content, 1200);
          const published = text(item.PublishTime, 50);
          sources.push({
            source_id: crypto.randomUUID(),
            title,
            url,
            snippet: text(item.Snippet, 300),
            content: content || summary,
            content_kind: content
              ? "provider_content"
              : summary
                ? "provider_summary"
                : "snippet_only",
            published_at:
              /^\d{4}-\d{2}-\d{2}T/.test(published) &&
              Number.isFinite(Date.parse(published))
                ? published
                : null,
            verification_status: "unverified",
          });
          if (sources.length === 5) break;
        }
        return {
          provider: "doubao-custom",
          provider_request_id: requestId,
          searched_at: Date.now(),
          sources,
        };
      } catch (error) {
        throw error instanceof SearchError
          ? error
          : new SearchError("SEARCH_RESULT_UNKNOWN");
      }
    },
  };
}
