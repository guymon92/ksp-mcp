# KSP MCP Server

An MCP (Model Context Protocol) server for searching and browsing products on [KSP.co.il](https://ksp.co.il) — one of Israel's largest electronics and retail stores.

Deployed as a **Cloudflare Worker** — no local install required. Just connect the URL and start searching.

## Tools

### `search_products`

Search for products on KSP. Supports Hebrew and English search terms.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search term (e.g. `"iphone 15"`, `"מקלדת"`, `"אוזניות"`) |
| `page` | int | 1 | Page number (12 items per page) |

Returns: product names, prices, club prices, labels, payment info, and direct links.

### `get_product`

Get detailed information about a specific product by its ID.

| Parameter | Type | Description |
|-----------|------|-------------|
| `uin` | string | Product ID number (e.g. `"368086"`) or full KSP URL |

Returns: full details including price, description, specs, color/storage variations, images, branch availability, and payment options.

## Quick Start — Connect to Your MCP Client

The server is deployed at:

```
https://ksp-mcp.<your-account>.workers.dev
```

Endpoints:
- **SSE:** `https://ksp-mcp.<your-account>.workers.dev/sse`
- **Streamable HTTP:** `https://ksp-mcp.<your-account>.workers.dev/mcp`

### Claude Code

```bash
claude mcp add ksp --transport sse https://ksp-mcp.<your-account>.workers.dev/sse
```

### Claude Desktop

Add to your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ksp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://ksp-mcp.<your-account>.workers.dev/sse"
      ]
    }
  }
}
```

### Cursor / Windsurf / Any MCP Client

Use the SSE URL directly in your client's MCP server settings:

```
https://ksp-mcp.<your-account>.workers.dev/sse
```

### Claude.ai (Connectors)

1. Go to [Claude.ai](https://claude.ai) settings
2. Navigate to **Integrations** or **Connectors**
3. Click **Add MCP Server**
4. Enter the SSE URL: `https://ksp-mcp.<your-account>.workers.dev/sse`
5. The `search_products` and `get_product` tools will appear in your chat

---

## Self-Hosting / Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)

### Setup

```bash
git clone https://github.com/guymon92/ksp-mcp.git
cd ksp-mcp
npm install
```

### Local development

```bash
npm run dev
# Server runs at http://localhost:8787
# SSE endpoint: http://localhost:8787/sse
# Streamable HTTP endpoint: http://localhost:8787/mcp
```

### Deploy to Cloudflare

```bash
npx wrangler login   # First time only
npm run deploy
```

Your server will be live at `https://ksp-mcp.<your-account>.workers.dev`.

---

## How it works

KSP.co.il is a React SPA that loads product data from an internal JSON API at `https://ksp.co.il/m_action/api/`. This server calls that API directly — no HTML scraping needed.

- **Search:** `GET /m_action/api/category/?search=<term>&page=<n>`
- **Product detail:** `GET /m_action/api/item/<uin>`

## Tech Stack

- **Runtime:** Cloudflare Workers (TypeScript)
- **MCP SDK:** `@modelcontextprotocol/sdk` + `agents` (Cloudflare Agents SDK)
- **Transport:** SSE and Streamable HTTP via Durable Objects
