/**
 * Bug.co.il — major Israeli electronics retailer.
 *
 * Bug does not publish a public API. This module attempts:
 *   1. Mobile-app JSON API (same m_action pattern as KSP, common among Israeli retailers)
 *   2. HTML page parsing — extracts embedded __NEXT_DATA__ or structured JSON
 *
 * If Bug changes their site structure, update BUG_API / BUG_SEARCH_URL accordingly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatPrice, makeHeaders, siteError, noResults } from "../utils.js";

const BUG_ORIGIN = "https://www.bug.co.il";
const BUG_API = `${BUG_ORIGIN}/m_action/api`;

// Headers mimicking a real browser visit
const HEADERS_JSON = makeHeaders(BUG_ORIGIN);
const HEADERS_HTML = {
  ...makeHeaders(BUG_ORIGIN),
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ─── Types ─────────────────────────────────────────────────────────────────

interface BugProduct {
  name: string;
  uin?: string;
  id?: string | number;
  price?: number;
  min_price?: number;
  brandName?: string;
  brand?: string;
  description?: string;
  img?: string;
  image?: string;
  inStock?: boolean;
  addToCart?: boolean;
}

// ─── HTML helpers ──────────────────────────────────────────────────────────

/**
 * Attempt to pull embedded JSON blobs from an HTML page.
 * Israeli retail sites often embed product data as:
 *   - window.__NEXT_DATA__ = {...}
 *   - window.__INITIAL_STATE__ = {...}
 *   - <script type="application/ld+json">...</script>
 */
function extractJsonFromHtml(html: string): unknown[] {
  const results: unknown[] = [];

  // Next.js __NEXT_DATA__
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (nextDataMatch) {
    try { results.push(JSON.parse(nextDataMatch[1])); } catch { /* ignore */ }
  }

  // __INITIAL_STATE__ or similar window assignments
  const initStateMatch = html.match(/window\.__(?:INITIAL_STATE|STATE|DATA)__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script)/);
  if (initStateMatch) {
    try { results.push(JSON.parse(initStateMatch[1])); } catch { /* ignore */ }
  }

  // JSON-LD structured data
  const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const m of jsonLdMatches) {
    try { results.push(JSON.parse(m[1])); } catch { /* ignore */ }
  }

  return results;
}

/**
 * Parse basic product cards from Bug's HTML using regex heuristics.
 * Returns an array of partial BugProduct objects.
 */
function parseHtmlProducts(html: string): BugProduct[] {
  const products: BugProduct[] = [];

  // Try to find product data in JSON-LD ItemList or Product schemas
  const blobs = extractJsonFromHtml(html);
  for (const blob of blobs) {
    const b = blob as Record<string, unknown>;
    if (b["@type"] === "ItemList" && Array.isArray(b["itemListElement"])) {
      for (const el of b["itemListElement"] as Record<string, unknown>[]) {
        const item = (el["item"] as Record<string, unknown>) ?? el;
        if (item["name"]) {
          products.push({
            name: String(item["name"]),
            id: item["@id"] ? String(item["@id"]).match(/\d+/)?.[0] : undefined,
            price: item["offers"]
              ? Number((item["offers"] as Record<string, unknown>)["price"] ?? 0) || undefined
              : undefined,
            description: item["description"] ? String(item["description"]) : undefined,
            img: item["image"] ? String(item["image"]) : undefined,
          });
        }
      }
    }
    if (b["@type"] === "Product" && b["name"]) {
      const offers = b["offers"] as Record<string, unknown> | undefined;
      products.push({
        name: String(b["name"]),
        id: b["@id"] ? String(b["@id"]).match(/\d+/)?.[0] : undefined,
        price: offers ? Number(offers["price"] ?? 0) || undefined : undefined,
        brand: b["brand"] ? String((b["brand"] as Record<string, unknown>)["name"] ?? b["brand"]) : undefined,
        description: b["description"] ? String(b["description"]) : undefined,
        img: b["image"] ? String(b["image"]) : undefined,
      });
    }
  }

  return products;
}

// ─── Format helpers ────────────────────────────────────────────────────────

function formatBugProduct(p: BugProduct, index: number): string {
  const id = p.uin ?? p.id;
  const brand = p.brandName ?? p.brand;
  const img = p.img ?? p.image;
  const lines: string[] = [`${index}. **${p.name}**`];

  if (p.price) lines.push(`   Price: ${formatPrice(p.price)}`);
  if (p.min_price && p.min_price !== p.price) lines.push(`   Sale price: ${formatPrice(p.min_price)}`);
  if (brand) lines.push(`   Brand: ${brand}`);
  if (p.description) lines.push(`   ${p.description}`);
  if (id) lines.push(`   URL: ${BUG_ORIGIN}/p/${id}`);
  if (img) lines.push(`   Image: ${img}`);

  return lines.join("\n");
}

// ─── API fetch with fallback ───────────────────────────────────────────────

async function searchBug(query: string, page: number): Promise<{ products: BugProduct[]; total?: number; source: string }> {
  // 1. Try mobile JSON API (same pattern as KSP)
  try {
    const params = new URLSearchParams({ search: query });
    if (page > 1) params.set("page", String(page));
    const apiResp = await fetch(`${BUG_API}/category/?${params}`, { headers: HEADERS_JSON });
    if (apiResp.ok) {
      const json = (await apiResp.json()) as { result?: { items?: BugProduct[]; products_total?: number } };
      const items = json.result?.items ?? [];
      if (items.length > 0) {
        return { products: items, total: json.result?.products_total, source: "api" };
      }
    }
  } catch { /* fall through */ }

  // 2. Try HTML page scraping
  const searchUrl = `${BUG_ORIGIN}/catalog.aspx?act=search&q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;
  const htmlResp = await fetch(searchUrl, { headers: HEADERS_HTML });
  if (!htmlResp.ok) return { products: [], source: "html-failed" };

  const html = await htmlResp.text();
  const products = parseHtmlProducts(html);
  return { products, source: "html" };
}

async function getBugProduct(id: string): Promise<{ product: BugProduct | null; source: string }> {
  // 1. Try JSON API
  try {
    const apiResp = await fetch(`${BUG_API}/item/${id}`, { headers: HEADERS_JSON });
    if (apiResp.ok) {
      const json = (await apiResp.json()) as { result?: { data?: BugProduct } };
      if (json.result?.data?.name) {
        return { product: { ...json.result.data, id }, source: "api" };
      }
    }
  } catch { /* fall through */ }

  // 2. Fetch product HTML page
  const pageUrl = `${BUG_ORIGIN}/p/${id}`;
  const htmlResp = await fetch(pageUrl, { headers: HEADERS_HTML });
  if (!htmlResp.ok) return { product: null, source: "html-failed" };

  const html = await htmlResp.text();
  const products = parseHtmlProducts(html);
  const product = products[0] ?? null;
  if (product) product.id = id;
  return { product, source: "html" };
}

// ─── Tool registration ─────────────────────────────────────────────────────

export function registerBugTools(server: McpServer) {
  server.tool(
    "bug_search_products",
    `Search for products on Bug.co.il — a major Israeli electronics retailer.
Returns product names, prices, descriptions, and links. Supports Hebrew and English search terms.`,
    {
      query: z
        .string()
        .describe("Search term (e.g. 'iphone 16', 'מקלדת', 'אוזניות')"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number for pagination (default: 1)"),
    },
    async ({ query, page }) => {
      const { products, total, source } = await searchBug(query, page);

      if (products.length === 0) {
        if (source === "html-failed") {
          return siteError("Bug", 403);
        }
        return noResults(query, "Bug");
      }

      const lines = products.map((p, i) => formatBugProduct(p, (page - 1) * 12 + i + 1));
      let summary = total
        ? `Found ${total} products for "${query}" on Bug (showing page ${page}):\n\n`
        : `Results for "${query}" on Bug:\n\n`;
      summary += lines.join("\n\n");
      summary += `\n\nSearch URL: ${BUG_ORIGIN}/catalog.aspx?act=search&q=${encodeURIComponent(query)}`;

      return { content: [{ type: "text" as const, text: summary }] };
    }
  );

  server.tool(
    "bug_get_product",
    `Get detailed product information from Bug.co.il by product ID or URL.`,
    {
      id: z
        .string()
        .describe("Product ID number or full Bug.co.il URL"),
    },
    async ({ id }) => {
      const match = id.match(/\d+/);
      if (!match) {
        return { content: [{ type: "text" as const, text: "Invalid product ID." }] };
      }
      const productId = match[0];

      const { product, source } = await getBugProduct(productId);

      if (!product) {
        return source === "html-failed"
          ? siteError("Bug", 403)
          : { content: [{ type: "text" as const, text: `Product ${productId} not found on Bug.` }] };
      }

      const brand = product.brandName ?? product.brand;
      let text = `**${product.name}**\n\n`;
      if (product.price) text += `Price: ${formatPrice(product.price)}\n`;
      if (product.min_price && product.min_price !== product.price) {
        text += `Sale price: ${formatPrice(product.min_price)}\n`;
      }
      if (brand) text += `Brand: ${brand}\n`;
      if (product.inStock !== undefined) {
        text += `In stock: ${product.inStock || product.addToCart ? "Yes" : "No"}\n`;
      }
      if (product.description) text += `\nDescription: ${product.description}\n`;
      const img = product.img ?? product.image;
      if (img) text += `\nImage: ${img}\n`;
      text += `\nURL: ${BUG_ORIGIN}/p/${productId}`;

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
