/**
 * ADCS.co.il (Amirim Distribution) — Israeli B2B distributor for Apple, Dell,
 * Lenovo, Microsoft Surface, and other enterprise/consumer tech brands.
 *
 * ADCS does not publish a public API. This module:
 *   1. Probes for a mobile JSON API endpoint
 *   2. Falls back to HTML scraping of catalog.aspx search pages
 *
 * Note: As a B2B distributor, some product pricing may require account login.
 * The tools surface whatever public data is available.
 *
 * Search URL: https://www.adcs.co.il/catalog.aspx?act=search&q=<query>
 * Product URL: https://www.adcs.co.il/catalog.aspx?act=product&id=<id>
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatPrice, makeHeaders, siteError, noResults } from "../utils.js";

const ADCS_ORIGIN = "https://www.adcs.co.il";
const ADCS_API = `${ADCS_ORIGIN}/m_action/api`;

const HEADERS_JSON = makeHeaders(ADCS_ORIGIN);
const HEADERS_HTML = {
  ...makeHeaders(ADCS_ORIGIN),
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ─── Types ─────────────────────────────────────────────────────────────────

interface AdcsProduct {
  name: string;
  id?: string | number;
  uin?: string;
  price?: number;
  salePrice?: number;
  brand?: string;
  brandName?: string;
  description?: string;
  img?: string;
  image?: string;
  inStock?: boolean;
  addToCart?: boolean;
  sku?: string;
  category?: string;
}

// ─── HTML parsing ──────────────────────────────────────────────────────────

function extractJsonBlobs(html: string): unknown[] {
  const results: unknown[] = [];

  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (nextDataMatch) {
    try { results.push(JSON.parse(nextDataMatch[1])); } catch { /* ignore */ }
  }

  const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const m of jsonLdMatches) {
    try { results.push(JSON.parse(m[1])); } catch { /* ignore */ }
  }

  return results;
}

function parseAdcsHtml(html: string): AdcsProduct[] {
  const products: AdcsProduct[] = [];

  const blobs = extractJsonBlobs(html);
  for (const blob of blobs) {
    const b = blob as Record<string, unknown>;
    if (b["@type"] === "ItemList" && Array.isArray(b["itemListElement"])) {
      for (const el of b["itemListElement"] as Record<string, unknown>[]) {
        const item = (el["item"] as Record<string, unknown>) ?? el;
        if (item["name"]) {
          const offers = item["offers"] as Record<string, unknown> | undefined;
          products.push({
            name: String(item["name"]),
            id: item["@id"] ? String(item["@id"]).match(/id=(\d+)/)?.[1] : undefined,
            price: offers ? Number(offers["price"] ?? 0) || undefined : undefined,
            brand: item["brand"]
              ? String((item["brand"] as Record<string, unknown>)["name"] ?? item["brand"])
              : undefined,
            sku: item["sku"] ? String(item["sku"]) : undefined,
            description: item["description"] ? String(item["description"]) : undefined,
            img: item["image"]
              ? String(Array.isArray(item["image"]) ? item["image"][0] : item["image"])
              : undefined,
          });
        }
      }
    }
    if (b["@type"] === "Product" && b["name"]) {
      const offers = b["offers"] as Record<string, unknown> | undefined;
      const urlId = b["url"] ? String(b["url"]).match(/id=(\d+)/)?.[1] : undefined;
      products.push({
        name: String(b["name"]),
        id: urlId,
        sku: b["sku"] ? String(b["sku"]) : undefined,
        price: offers ? Number(offers["price"] ?? 0) || undefined : undefined,
        brand: b["brand"]
          ? String((b["brand"] as Record<string, unknown>)["name"] ?? b["brand"])
          : undefined,
        description: b["description"] ? String(b["description"]) : undefined,
        img: b["image"]
          ? String(Array.isArray(b["image"]) ? b["image"][0] : b["image"])
          : undefined,
        inStock: offers ? offers["availability"] === "https://schema.org/InStock" : undefined,
      });
    }
  }

  // Fallback: find product links
  if (products.length === 0) {
    const productLinkPattern = /catalog\.aspx\?act=product&(?:amp;)?id=(\d+)[^"]*"[^>]*>([^<]+)</g;
    const seen = new Set<string>();
    for (const m of html.matchAll(productLinkPattern)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        products.push({ name: m[2].trim(), id: m[1] });
      }
    }
  }

  return products;
}

// ─── Format helpers ────────────────────────────────────────────────────────

function productUrl(id: string | number | undefined): string {
  return id ? `${ADCS_ORIGIN}/catalog.aspx?act=product&id=${id}` : ADCS_ORIGIN;
}

function formatAdcsProduct(p: AdcsProduct, index: number): string {
  const id = p.uin ?? p.id;
  const brand = p.brandName ?? p.brand;
  const img = p.img ?? p.image;
  const displayPrice = p.salePrice ?? p.price;
  const lines: string[] = [`${index}. **${p.name}**`];

  if (displayPrice) lines.push(`   Price: ${formatPrice(displayPrice)}`);
  else lines.push(`   Price: Contact for pricing (B2B)`);
  if (brand) lines.push(`   Brand: ${brand}`);
  if (p.sku) lines.push(`   SKU: ${p.sku}`);
  if (p.category) lines.push(`   Category: ${p.category}`);
  if (p.description) lines.push(`   ${p.description}`);
  lines.push(`   URL: ${productUrl(id)}`);
  if (img) lines.push(`   Image: ${img}`);

  return lines.join("\n");
}

// ─── Fetch logic ───────────────────────────────────────────────────────────

async function searchAdcs(query: string, page: number): Promise<{ products: AdcsProduct[]; total?: number; source: string }> {
  // 1. Try mobile JSON API
  try {
    const params = new URLSearchParams({ search: query });
    if (page > 1) params.set("page", String(page));
    const apiResp = await fetch(`${ADCS_API}/category/?${params}`, { headers: HEADERS_JSON });
    if (apiResp.ok) {
      const json = (await apiResp.json()) as { result?: { items?: AdcsProduct[]; products_total?: number } };
      const items = json.result?.items ?? [];
      if (items.length > 0) {
        return { products: items, total: json.result?.products_total, source: "api" };
      }
    }
  } catch { /* fall through */ }

  // 2. HTML scraping
  const searchUrl = `${ADCS_ORIGIN}/catalog.aspx?act=search&q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;
  const htmlResp = await fetch(searchUrl, { headers: HEADERS_HTML });
  if (!htmlResp.ok) return { products: [], source: "html-failed" };

  const html = await htmlResp.text();
  const products = parseAdcsHtml(html);
  return { products, source: "html" };
}

async function getAdcsProduct(id: string): Promise<{ product: AdcsProduct | null; source: string }> {
  // 1. Try JSON API
  try {
    const apiResp = await fetch(`${ADCS_API}/item/${id}`, { headers: HEADERS_JSON });
    if (apiResp.ok) {
      const json = (await apiResp.json()) as { result?: { data?: AdcsProduct } };
      if (json.result?.data?.name) {
        return { product: { ...json.result.data, id }, source: "api" };
      }
    }
  } catch { /* fall through */ }

  // 2. Product HTML page
  const pageUrl = `${ADCS_ORIGIN}/catalog.aspx?act=product&id=${id}`;
  const htmlResp = await fetch(pageUrl, { headers: HEADERS_HTML });
  if (!htmlResp.ok) return { product: null, source: "html-failed" };

  const html = await htmlResp.text();
  const products = parseAdcsHtml(html);
  const product = products[0] ?? null;
  if (product) product.id = id;
  return { product, source: "html" };
}

// ─── Tool registration ─────────────────────────────────────────────────────

export function registerAdcsTools(server: McpServer) {
  server.tool(
    "adcs_search_products",
    `Search for products on ADCS.co.il (Amirim Distribution) — Israeli authorized distributor for Apple, Dell, Lenovo, and Microsoft Surface.
As a B2B distributor, some prices may require account login. Supports Hebrew and English search terms.`,
    {
      query: z
        .string()
        .describe("Search term (e.g. 'macbook pro', 'dell xps', 'surface pro', 'אייפד')"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number for pagination (default: 1)"),
    },
    async ({ query, page }) => {
      const { products, total, source } = await searchAdcs(query, page);

      if (products.length === 0) {
        if (source === "html-failed") return siteError("ADCS", 403);
        return noResults(query, "ADCS");
      }

      const lines = products.map((p, i) => formatAdcsProduct(p, (page - 1) * 12 + i + 1));
      let summary = total
        ? `Found ${total} products for "${query}" on ADCS (showing page ${page}):\n\n`
        : `Results for "${query}" on ADCS:\n\n`;
      summary += lines.join("\n\n");
      summary += `\n\nSearch URL: ${ADCS_ORIGIN}/catalog.aspx?act=search&q=${encodeURIComponent(query)}`;

      return { content: [{ type: "text" as const, text: summary }] };
    }
  );

  server.tool(
    "adcs_get_product",
    `Get detailed product information from ADCS.co.il by product ID or URL.`,
    {
      id: z
        .string()
        .describe("Product ID number or full ADCS.co.il URL"),
    },
    async ({ id }) => {
      const match = id.match(/\d+/);
      if (!match) {
        return { content: [{ type: "text" as const, text: "Invalid product ID." }] };
      }
      const productId = match[0];

      const { product, source } = await getAdcsProduct(productId);

      if (!product) {
        return source === "html-failed"
          ? siteError("ADCS", 403)
          : { content: [{ type: "text" as const, text: `Product ${productId} not found on ADCS.` }] };
      }

      const brand = product.brandName ?? product.brand;
      const displayPrice = product.salePrice ?? product.price;
      let text = `**${product.name}**\n\n`;
      if (displayPrice) text += `Price: ${formatPrice(displayPrice)}\n`;
      else text += `Price: Contact for pricing (B2B)\n`;
      if (brand) text += `Brand: ${brand}\n`;
      if (product.sku) text += `SKU: ${product.sku}\n`;
      if (product.category) text += `Category: ${product.category}\n`;
      if (product.inStock !== undefined) {
        text += `In stock: ${product.inStock || product.addToCart ? "Yes" : "No"}\n`;
      }
      if (product.description) text += `\nDescription: ${product.description}\n`;
      const img = product.img ?? product.image;
      if (img) text += `\nImage: ${img}\n`;
      text += `\nURL: ${productUrl(productId)}`;

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
