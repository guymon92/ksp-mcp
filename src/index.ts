import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KSP_API = "https://ksp.co.il/m_action/api";
const KSP_WEB = "https://ksp.co.il/web";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
  Referer: `${KSP_WEB}/`,
  Origin: "https://ksp.co.il",
};

function formatPrice(price: number | null | undefined): string | null {
  if (price == null) return null;
  return `₪${Math.round(price).toLocaleString("en-US")}`;
}

interface Label {
  msg: string;
}

interface Payments {
  max_num_payments_wo_interest?: number;
  estimated_payment?: number;
}

interface ProductItem {
  name: string;
  uin: string;
  price?: number;
  min_price?: number;
  brandName?: string;
  labels?: Label[];
  payments?: Payments;
  description?: string;
  img?: string;
}

function formatProduct(item: ProductItem, index: number): string {
  const lines: string[] = [`${index}. **${item.name}**`];

  lines.push(`   Price: ${formatPrice(item.price ?? null)}`);
  if (item.min_price && item.min_price !== item.price) {
    lines.push(`   Club price: ${formatPrice(item.min_price)}`);
  }

  if (item.brandName) {
    lines.push(`   Brand: ${item.brandName}`);
  }

  const labels = item.labels || [];
  if (labels.length > 0) {
    lines.push(`   ${labels.map((l) => l.msg).join(" | ")}`);
  }

  const payments = item.payments || {};
  if (payments.max_num_payments_wo_interest) {
    lines.push(
      `   Payments: up to ${payments.max_num_payments_wo_interest} interest-free (est. ${formatPrice(payments.estimated_payment ?? null)}/mo)`
    );
  }

  if (item.description) {
    lines.push(`   ${item.description}`);
  }

  lines.push(`   URL: ${KSP_WEB}/item/${item.uin}`);
  if (item.img) {
    lines.push(`   Image: ${item.img}`);
  }

  return lines.join("\n");
}

export class KspMCP extends McpAgent {
  server = new McpServer({
    name: "ksp-mcp",
    version: "0.1.0",
  });

  async init() {
    this.server.tool(
      "search_products",
      `Search for products on KSP.co.il — one of Israel's largest electronics and retail stores.
Returns product names, prices, descriptions, and links. Supports Hebrew and English search terms.`,
      {
        query: z
          .string()
          .describe(
            "Search term (e.g. 'iphone 15', 'מקלדת', 'אוזניות')"
          ),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Page number for pagination (default: 1, 12 items per page)"),
      },
      async ({ query, page }) => {
        const params = new URLSearchParams({ search: query });
        if (page > 1) params.set("page", String(page));

        const resp = await fetch(`${KSP_API}/category/?${params}`, {
          headers: HEADERS,
        });
        if (!resp.ok) {
          return {
            content: [
              { type: "text" as const, text: `KSP API error: ${resp.status}` },
            ],
          };
        }

        const json = (await resp.json()) as {
          result: {
            items?: ProductItem[];
            products_total?: number;
            minMax?: { min: number; max: number };
            next?: number;
          };
        };
        const result = json.result;
        const items = result.items || [];

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No products found for "${query}" on KSP.`,
              },
            ],
          };
        }

        const productLines = items.map((item, i) =>
          formatProduct(item, (page - 1) * 12 + i + 1)
        );

        let summary = `Found ${result.products_total} products for "${query}" on KSP (showing page ${page}):\n\n`;
        summary += productLines.join("\n\n");

        if (result.minMax) {
          summary += `\n\n---\nPrice range: ${formatPrice(result.minMax.min)} – ${formatPrice(result.minMax.max)}`;
        }

        if (result.next && result.next > 0) {
          summary += `\nMore results available — use page ${page + 1} to see next page.`;
        }

        summary += `\n\nSearch URL: ${KSP_WEB}/cat/?search=${query}`;

        return { content: [{ type: "text" as const, text: summary }] };
      }
    );

    this.server.tool(
      "get_product",
      `Get detailed information about a specific product on KSP.co.il including specs, variations, stock, and images.`,
      {
        uin: z
          .string()
          .describe(
            "Product UIN (ID number) from KSP, e.g. '368086'. Can also be a full URL."
          ),
      },
      async ({ uin }) => {
        const match = uin.match(/\d+/);
        if (!match) {
          return {
            content: [{ type: "text" as const, text: "Invalid product ID." }],
          };
        }
        const productId = match[0];

        const resp = await fetch(`${KSP_API}/item/${productId}`, {
          headers: HEADERS,
        });
        if (!resp.ok) {
          return {
            content: [
              { type: "text" as const, text: `KSP API error: ${resp.status}` },
            ],
          };
        }

        const json = (await resp.json()) as {
          result: {
            data: {
              name: string;
              price: number;
              min_price?: number;
              eilatPrice?: number;
              brandName?: string;
              addToCart?: boolean;
              smalldesc?: string;
            };
            products_options?: {
              render?: {
                tags?: Record<
                  string,
                  {
                    name: string;
                    items: { id: number; name: string }[];
                  }
                >;
              };
              variations?: {
                tags: Record<string, string>;
                data: { price?: number; bms_price?: number };
              }[];
            };
            specification?: { name: string; value: string }[];
            images?: (string | { url: string })[];
            stock?: { name?: string; title?: string }[];
            payments?: Payments;
          };
        };

        const r = json.result;
        const d = r.data;
        let text = `**${d.name}**\n\n`;
        text += `Price: ${formatPrice(d.price)}\n`;

        if (d.min_price && d.min_price !== d.price) {
          text += `Club price: ${formatPrice(d.min_price)}\n`;
        }
        if (d.eilatPrice) {
          text += `Eilat (tax-free) price: ${formatPrice(d.eilatPrice)}\n`;
        }

        text += `Brand: ${d.brandName || "N/A"}\n`;
        text += `In stock: ${d.addToCart ? "Yes" : "No"}\n`;

        if (d.smalldesc) {
          text += `\nDescription: ${d.smalldesc}\n`;
        }

        // Product variations
        const options = r.products_options || {};
        const render = options.render || {};
        const tags = render.tags || {};

        if (Object.keys(tags).length > 0) {
          text += "\n**Options:**\n";
          for (const tagGroup of Object.values(tags)) {
            const optionNames = tagGroup.items.map((i) => i.name).join(", ");
            text += `  ${tagGroup.name}: ${optionNames}\n`;
          }
        }

        const variations = options.variations || [];
        if (variations.length > 1) {
          text += "\n**Variations:**\n";
          for (const v of variations) {
            const varParts: string[] = [];
            for (const [k, vId] of Object.entries(v.tags)) {
              const tagGroup = tags[k];
              if (tagGroup) {
                const item = tagGroup.items.find(
                  (i) => String(i.id) === String(vId)
                );
                if (item) {
                  varParts.push(`${tagGroup.name}: ${item.name}`);
                }
              }
            }
            const varData = v.data || {};
            let line = `  - ${varParts.join(", ")} → ${formatPrice(Math.round(varData.price || 0))}`;
            if (varData.bms_price && varData.bms_price !== Math.round(varData.price || 0)) {
              line += ` (club: ${formatPrice(varData.bms_price)})`;
            }
            text += line + "\n";
          }
        }

        // Specifications
        const specs = r.specification || [];
        if (specs.length > 0) {
          text += "\n**Specifications:**\n";
          for (const spec of specs) {
            text += `  - ${spec.name}: ${spec.value}\n`;
          }
        }

        // Images
        const images = r.images || [];
        if (images.length > 0) {
          text += "\n**Images:**\n";
          for (const img of images.slice(0, 5)) {
            text += `  ${typeof img === "string" ? img : img.url}\n`;
          }
        }

        // Stock / pickup
        const stock = r.stock || [];
        if (stock.length > 0) {
          text += "\n**Available at branches:**\n";
          for (const s of stock.slice(0, 5)) {
            text += `  - ${s.name || s.title || JSON.stringify(s)}\n`;
          }
        }

        // Payments
        const payments = r.payments || {};
        if (payments.max_num_payments_wo_interest) {
          text += `\nPayment options: up to ${payments.max_num_payments_wo_interest} interest-free payments\n`;
        }

        text += `\nURL: ${KSP_WEB}/item/${productId}`;

        return { content: [{ type: "text" as const, text }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return KspMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/message") {
      return KspMCP.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "ksp-mcp",
          description:
            "MCP server for searching products on KSP.co.il",
          endpoints: {
            sse: "/sse",
            mcp: "/mcp",
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
