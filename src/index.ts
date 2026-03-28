import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerKspTools } from "./sites/ksp.js";
import { registerBugTools } from "./sites/bug.js";
import { registerIvoryTools } from "./sites/ivory.js";
import { registerAdcsTools } from "./sites/adcs.js";

// ─── Cross-site search types ───────────────────────────────────────────────

interface SiteResult {
  site: string;
  name: string;
  price?: number;
  brand?: string;
  url?: string;
}

// Pull a price number out of whatever JSON a site returns so we can sort
function extractPrice(text: string): number {
  const m = text.match(/₪([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : Infinity;
}

// ─── Main MCP agent ────────────────────────────────────────────────────────

export class IsraeliRetailMCP extends McpAgent {
  // @ts-expect-error — McpServer version mismatch between agents bundled SDK and top-level install
  server = new McpServer({
    name: "israeli-retail-mcp",
    version: "0.2.0",
  });

  async init() {
    // Register per-site tools
    registerKspTools(this.server);
    registerBugTools(this.server);
    registerIvoryTools(this.server);
    registerAdcsTools(this.server);

    // ── Cross-site search ──────────────────────────────────────────────────
    this.server.tool(
      "search_all_sites",
      `Search for a product across all supported Israeli retail sites simultaneously:
KSP, Bug, Ivory, and ADCS. Results are merged and sorted by price (lowest first).
Useful for quick price comparison across stores.`,
      {
        query: z
          .string()
          .describe("Product to search for (Hebrew or English, e.g. 'iphone 16', 'מקלדת')"),
      },
      async ({ query }) => {
        const params = new URLSearchParams({ search: query });

        // Fire all searches in parallel
        const [kspResp, bugResp, ivoryResp, adcsResp] = await Promise.allSettled([
          fetch(`https://ksp.co.il/m_action/api/category/?${params}`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
              Accept: "application/json",
              "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
              Referer: "https://ksp.co.il/web/",
              Origin: "https://ksp.co.il",
            },
          }),
          fetch(`https://www.bug.co.il/m_action/api/category/?${params}`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
              Accept: "application/json",
              "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
              Referer: "https://www.bug.co.il/",
              Origin: "https://www.bug.co.il",
            },
          }),
          fetch(`https://www.ivory.co.il/m_action/api/category/?${params}`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
              Accept: "application/json",
              "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
              Referer: "https://www.ivory.co.il/",
              Origin: "https://www.ivory.co.il",
            },
          }),
          fetch(`https://www.adcs.co.il/m_action/api/category/?${params}`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
              Accept: "application/json",
              "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
              Referer: "https://www.adcs.co.il/",
              Origin: "https://www.adcs.co.il",
            },
          }),
        ]);

        const siteNames = ["KSP", "Bug", "Ivory", "ADCS"];
        const siteUrls = [
          (id: string) => `https://ksp.co.il/web/item/${id}`,
          (id: string) => `https://www.bug.co.il/p/${id}`,
          (id: string) => `https://www.ivory.co.il/catalog.aspx?act=product&id=${id}`,
          (id: string) => `https://www.adcs.co.il/catalog.aspx?act=product&id=${id}`,
        ];

        const allResults: SiteResult[] = [];
        const statuses: string[] = [];

        const responses = [kspResp, bugResp, ivoryResp, adcsResp];
        for (let i = 0; i < responses.length; i++) {
          const settled = responses[i];
          const siteName = siteNames[i];
          const urlBuilder = siteUrls[i];

          if (settled.status === "rejected") {
            statuses.push(`${siteName}: ❌ network error`);
            continue;
          }

          const resp = settled.value;
          if (!resp.ok) {
            statuses.push(`${siteName}: ❌ ${resp.status}`);
            continue;
          }

          try {
            const json = (await resp.json()) as {
              result?: {
                items?: Array<{
                  name: string;
                  uin?: string;
                  id?: string | number;
                  price?: number;
                  min_price?: number;
                  brandName?: string;
                  brand?: string;
                }>;
                products_total?: number;
              };
            };
            const items = json.result?.items ?? [];
            const total = json.result?.products_total;
            statuses.push(`${siteName}: ✅ ${total ?? items.length} results`);
            for (const item of items.slice(0, 5)) {
              const id = item.uin ?? String(item.id ?? "");
              allResults.push({
                site: siteName,
                name: item.name,
                price: item.min_price ?? item.price,
                brand: item.brandName ?? item.brand,
                url: id ? urlBuilder(id) : undefined,
              });
            }
          } catch {
            statuses.push(`${siteName}: ⚠️ parse error`);
          }
        }

        if (allResults.length === 0) {
          let text = `No results found for "${query}" across all sites.\n\n`;
          text += `Site status:\n${statuses.map((s) => `  ${s}`).join("\n")}\n\n`;
          text += `Try searching each site individually for more details.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Sort by price ascending (items with no price go last)
        allResults.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

        let text = `Price comparison for "${query}" across Israeli retail sites:\n\n`;
        text += `Site status: ${statuses.join(" | ")}\n\n`;

        for (let i = 0; i < allResults.length; i++) {
          const r = allResults[i];
          const priceStr = r.price ? `₪${r.price.toLocaleString("en-US")}` : "Price N/A";
          text += `${i + 1}. **[${r.site}]** ${r.name}\n`;
          text += `   ${priceStr}`;
          if (r.brand) text += ` · ${r.brand}`;
          text += "\n";
          if (r.url) text += `   ${r.url}\n`;
          text += "\n";
        }

        text += `\nUse site-specific tools (ksp_search_products, bug_search_products, etc.) for full search results.`;

        return { content: [{ type: "text" as const, text }] };
      }
    );
  }
}

// ─── Cloudflare Workers entry point ───────────────────────────────────────

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return IsraeliRetailMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/message") {
      return IsraeliRetailMCP.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "israeli-retail-mcp",
          version: "0.2.0",
          description: "MCP server for searching products across Israeli retail sites: KSP, Bug, Ivory, ADCS",
          sites: {
            ksp: "https://ksp.co.il",
            bug: "https://www.bug.co.il",
            ivory: "https://www.ivory.co.il",
            adcs: "https://www.adcs.co.il",
          },
          tools: [
            "ksp_search_products", "ksp_get_product",
            "bug_search_products", "bug_get_product",
            "ivory_search_products", "ivory_get_product",
            "adcs_search_products", "adcs_get_product",
            "search_all_sites",
          ],
          endpoints: { sse: "/sse", mcp: "/mcp" },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
