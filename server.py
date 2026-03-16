#!/usr/bin/env python3

import httpx
from mcp.server.fastmcp import FastMCP

KSP_API = "https://ksp.co.il/m_action/api"
KSP_WEB = "https://ksp.co.il/web"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": f"{KSP_WEB}/",
    "Origin": "https://ksp.co.il",
}

server = FastMCP(
    name="ksp-mcp",
    instructions="Search and browse products on KSP.co.il, one of Israel's largest electronics and retail stores.",
)


def format_price(price) -> str | None:
    if price is None:
        return None
    return f"₪{int(price):,}"


def format_product(item: dict, index: int) -> str:
    lines = [f"{index}. **{item['name']}**"]

    lines.append(f"   Price: {format_price(item.get('price'))}")
    min_price = item.get("min_price")
    if min_price and min_price != item.get("price"):
        lines.append(f"   Club price: {format_price(min_price)}")

    if item.get("brandName"):
        lines.append(f"   Brand: {item['brandName']}")

    labels = item.get("labels") or []
    if labels:
        lines.append(f"   {' | '.join(l['msg'] for l in labels)}")

    payments = item.get("payments") or {}
    if payments.get("max_num_payments_wo_interest"):
        lines.append(
            f"   Payments: up to {payments['max_num_payments_wo_interest']} interest-free "
            f"(est. {format_price(payments.get('estimated_payment'))}/mo)"
        )

    if item.get("description"):
        lines.append(f"   {item['description']}")

    lines.append(f"   URL: {KSP_WEB}/item/{item['uin']}")
    if item.get("img"):
        lines.append(f"   Image: {item['img']}")

    return "\n".join(lines)


@server.tool()
async def search_products(query: str, page: int = 1) -> str:
    """Search for products on KSP.co.il — one of Israel's largest electronics and retail stores.
    Returns product names, prices, descriptions, and links. Supports Hebrew and English search terms.

    Args:
        query: Search term (e.g. 'iphone 15', 'מקלדת', 'אוזניות')
        page: Page number for pagination (default: 1, 12 items per page)
    """
    params = {"search": query}
    if page > 1:
        params["page"] = page

    async with httpx.AsyncClient(headers=HEADERS) as client:
        resp = await client.get(f"{KSP_API}/category/", params=params)
        resp.raise_for_status()
        result = resp.json()["result"]

    items = result.get("items") or []
    if not items:
        return f'No products found for "{query}" on KSP.'

    product_lines = [
        format_product(item, (page - 1) * 12 + i + 1)
        for i, item in enumerate(items)
    ]

    summary = f'Found {result["products_total"]} products for "{query}" on KSP (showing page {page}):\n\n'
    summary += "\n\n".join(product_lines)

    min_max = result.get("minMax")
    if min_max:
        summary += f"\n\n---\nPrice range: {format_price(min_max['min'])} – {format_price(min_max['max'])}"

    if result.get("next") and result["next"] > 0:
        summary += f"\nMore results available — use page {page + 1} to see next page."

    summary += f"\n\nSearch URL: {KSP_WEB}/cat/?search={query}"
    return summary


@server.tool()
async def get_product(uin: str) -> str:
    """Get detailed information about a specific product on KSP.co.il including specs, variations, stock, and images.

    Args:
        uin: Product UIN (ID number) from KSP, e.g. '368086'. Can also be a full URL.
    """
    # Extract numeric ID if a full URL was provided
    import re

    match = re.search(r"\d+", uin)
    if not match:
        return "Invalid product ID."
    product_id = match.group()

    async with httpx.AsyncClient(headers=HEADERS) as client:
        resp = await client.get(f"{KSP_API}/item/{product_id}")
        resp.raise_for_status()
        r = resp.json()["result"]

    d = r["data"]
    text = f"**{d['name']}**\n\n"
    text += f"Price: {format_price(d['price'])}\n"

    if d.get("min_price") and d["min_price"] != d["price"]:
        text += f"Club price: {format_price(d['min_price'])}\n"
    if d.get("eilatPrice"):
        text += f"Eilat (tax-free) price: {format_price(d['eilatPrice'])}\n"

    text += f"Brand: {d.get('brandName', 'N/A')}\n"
    text += f"In stock: {'Yes' if d.get('addToCart') else 'No'}\n"

    if d.get("smalldesc"):
        text += f"\nDescription: {d['smalldesc']}\n"

    # Product variations
    options = r.get("products_options") or {}
    render = options.get("render") or {}
    tags = render.get("tags") or {}

    if tags:
        text += "\n**Options:**\n"
        for tag_group in tags.values():
            option_names = ", ".join(i["name"] for i in tag_group.get("items", []))
            text += f"  {tag_group['name']}: {option_names}\n"

    variations = options.get("variations") or []
    if len(variations) > 1:
        text += "\n**Variations:**\n"
        for v in variations:
            var_parts = []
            for k, v_id in v.get("tags", {}).items():
                tag_group = tags.get(k)
                if tag_group:
                    item = next(
                        (i for i in tag_group.get("items", []) if str(i["id"]) == str(v_id)),
                        None,
                    )
                    if item:
                        var_parts.append(f"{tag_group['name']}: {item['name']}")
            var_data = v.get("data", {})
            line = f"  - {', '.join(var_parts)} → {format_price(int(var_data.get('price', 0)))}"
            bms = var_data.get("bms_price")
            if bms and bms != int(var_data.get("price", 0)):
                line += f" (club: {format_price(bms)})"
            text += line + "\n"

    # Specifications
    specs = r.get("specification") or []
    if specs:
        text += "\n**Specifications:**\n"
        for spec in specs:
            text += f"  - {spec['name']}: {spec['value']}\n"

    # Images
    images = r.get("images") or []
    if images:
        text += "\n**Images:**\n"
        for img in images[:5]:
            text += f"  {img if isinstance(img, str) else img.get('url', img)}\n"

    # Stock / pickup
    stock = r.get("stock") or []
    if stock:
        text += "\n**Available at branches:**\n"
        for s in stock[:5]:
            name = s.get("name") or s.get("title") or str(s)
            text += f"  - {name}\n"

    # Payments
    payments = r.get("payments") or {}
    if payments.get("max_num_payments_wo_interest"):
        text += f"\nPayment options: up to {payments['max_num_payments_wo_interest']} interest-free payments\n"

    text += f"\nURL: {KSP_WEB}/item/{product_id}"
    return text


if __name__ == "__main__":
    server.run(transport="stdio")
