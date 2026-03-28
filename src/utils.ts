export function formatPrice(price: number | null | undefined): string | null {
  if (price == null) return null;
  return `₪${Math.round(price).toLocaleString("en-US")}`;
}

export function makeHeaders(origin: string, referer?: string): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "application/json, text/html,*/*",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: referer ?? `${origin}/`,
    Origin: origin,
  };
}

export function siteError(site: string, status: number) {
  return {
    content: [
      { type: "text" as const, text: `${site} API error: ${status}` },
    ],
  };
}

export function noResults(query: string, site: string) {
  return {
    content: [
      { type: "text" as const, text: `No products found for "${query}" on ${site}.` },
    ],
  };
}
