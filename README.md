# KSP MCP Server

An MCP (Model Context Protocol) server for searching and browsing products on [KSP.co.il](https://ksp.co.il) — one of Israel's largest electronics and retail stores.

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

## Prerequisites

- [uv](https://docs.astral.sh/uv/getting-started/installation/)

## Setup

```bash
git clone <repo-url>
cd ksp-mcp
uv sync
```

## Running

### With Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ksp": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/ksp-mcp", "server.py"]
    }
  }
}
```

Or add via CLI:

```bash
claude mcp add ksp -- uv run --directory /path/to/ksp-mcp server.py
```

### With Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "ksp": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/ksp-mcp", "server.py"]
    }
  }
}
```

### Standalone (for testing)

```bash
uv run server.py
```

The server communicates over stdio using the MCP protocol. It won't produce visible output — it's meant to be called by an MCP client.

### With MCP Inspector

```bash
uv run mcp dev server.py
```

This opens a web UI where you can test the tools interactively.

## How it works

KSP.co.il is a React SPA that loads product data from an internal JSON API at `https://ksp.co.il/m_action/api/`. This server calls that API directly — no HTML scraping needed.

- **Search endpoint:** `GET /m_action/api/category/?search=<term>&page=<n>`
- **Product detail endpoint:** `GET /m_action/api/item/<uin>`
