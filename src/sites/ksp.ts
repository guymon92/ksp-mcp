import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatPrice, makeHeaders, siteError, noResults } from "../utils.js";

const KSP_API = "https://ksp.co.il/m_action/api";
const KSP_WEB = "https://ksp.co.il/web";
const HEADERS = makeHeaders("https://ksp.co.il", `${KSP_WEB}/`);

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

export function registerKspTools(server: McpServer) {
  server.tool(
    "ksp_search_products",
    `Search for products on KSP.co.il — one of Israel's largest electronics and retail stores.
Returns product names, prices, descriptions, and links. Supports Hebrew and English search terms.`,
    {
      query: z
        .string()
        .describe("Search term (e.g. 'iphone 15', 'מקלדת', 'אוזניות')"),
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

      const resp = await fetch(`${KSP_API}/category/?${params}`, { headers: HEADERS });
      if (!resp.ok) return siteError("KSP", resp.status);

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

      if (items.length === 0) return noResults(query, "KSP");

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

  server.tool(
    "ksp_get_product",
    `Get detailed information about a specific product on KSP.co.il including specs, variations, stock, and images.`,
    {
      uin: z
        .string()
        .describe("Product UIN (ID number) from KSP, e.g. '368086'. Can also be a full URL."),
    },
    async ({ uin }) => {
      const match = uin.match(/\d+/);
      if (!match) {
        return { content: [{ type: "text" as const, text: "Invalid product ID." }] };
      }
      const productId = match[0];

      const resp = await fetch(`${KSP_API}/item/${productId}`, { headers: HEADERS });
      if (!resp.ok) return siteError("KSP", resp.status);

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
              tags?: Record<string, { name: string; items: { id: number; name: string }[] }>;
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

      const options = r.products_options || {};
      const render = options.render || {};
      const tags = render.tags || {};

      if (Object.keys(tags).length > 0) {
        text += "\n**Options:**\n";
        for (const tagGroup of Object.values(tags)) {
          text += `  ${tagGroup.name}: ${tagGroup.items.map((i) => i.name).join(", ")}\n`;
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
              const item = tagGroup.items.find((i) => String(i.id) === String(vId));
              if (item) varParts.push(`${tagGroup.name}: ${item.name}`);
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

      const specs = r.specification || [];
      if (specs.length > 0) {
        text += "\n**Specifications:**\n";
        for (const spec of specs) {
          text += `  - ${spec.name}: ${spec.value}\n`;
        }
      }

      const images = r.images || [];
      if (images.length > 0) {
        text += "\n**Images:**\n";
        for (const img of images.slice(0, 5)) {
          text += `  ${typeof img === "string" ? img : img.url}\n`;
        }
      }

      const stock = r.stock || [];
      if (stock.length > 0) {
        text += "\n**Available at branches:**\n";
        for (const s of stock.slice(0, 5)) {
          text += `  - ${s.name || s.title || JSON.stringify(s)}\n`;
        }
      }

      const payments = r.payments || {};
      if (payments.max_num_payments_wo_interest) {
        text += `\nPayment options: up to ${payments.max_num_payments_wo_interest} interest-free payments\n`;
      }

      text += `\nURL: ${KSP_WEB}/item/${productId}`;

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
