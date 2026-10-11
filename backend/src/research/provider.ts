export class ResearchError extends Error {
  code: string;
  constructor(code: string) {
    super("Source retrieval failed");
    this.code = code;
  }
}
const hosts = [
  "learnenglish.britishcouncil.org",
  "www.nhs.uk",
  "www.who.int",
  "www.aad.org",
];
export function sourceUrl(raw: string): string {
  const url = new URL(raw);
  if (
    raw.length > 2000 ||
    url.protocol !== "https:" ||
    !hosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    [...raw].some((char) => char.charCodeAt(0) <= 32 || char === "\\")
  )
    throw new ResearchError("SOURCE_URL_REJECTED");
  url.hash = "";
  return url.href;
}
export async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<string> {
  if (!body) throw new ResearchError("SOURCE_EMPTY");
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > max) {
      await reader.cancel();
      throw new ResearchError("SOURCE_TOO_LARGE");
    }
    parts.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(bytes);
}
function plain(html: string): string {
  return html
    .replace(
      /<(script|style|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(nbsp|amp|lt|gt|quot|#39);/g,
      (_m, k) =>
        ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[
          k as "nbsp"
        ],
    )
    .replace(/\s+/g, " ")
    .trim();
}
export interface ResearchProvider {
  read(
    url: string,
    signal: AbortSignal,
  ): Promise<{ title: string; excerpt: string }>;
}
export function webProvider(
  fetcher: typeof fetch = (...args) => fetch(...args),
): ResearchProvider {
  return {
    async read(raw, signal) {
      const url = sourceUrl(raw);
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { Accept: "text/html" },
        });
      } catch {
        throw new ResearchError(
          signal.aborted ? "SOURCE_TIMEOUT" : "SOURCE_NETWORK_ERROR",
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ResearchError(
          response.status >= 300 && response.status < 400
            ? "SOURCE_REDIRECT_REJECTED"
            : response.status === 401 || response.status === 403
              ? "SOURCE_ACCESS_DENIED"
              : response.status === 404
                ? "SOURCE_NOT_FOUND"
                : response.status === 429
                  ? "SOURCE_RATE_LIMITED"
                  : response.status >= 500
                    ? `SOURCE_SERVER_ERROR_${response.status}`
                    : "SOURCE_UNAVAILABLE",
        );
      }
      if (!/^text\/html\b/i.test(response.headers.get("Content-Type") ?? "")) {
        await response.body?.cancel();
        throw new ResearchError("SOURCE_TYPE_REJECTED");
      }
      const html = await boundedText(response.body, 262144);
      const title = plain(
        html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
          new URL(url).hostname,
      ).slice(0, 160);
      const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
      const excerpt = plain(main).slice(0, 1200);
      if (!excerpt) throw new ResearchError("SOURCE_EMPTY");
      return { title, excerpt };
    },
  };
}
