"use strict";
/**
 * utilSchemas124.js
 * JSON Schema for the shopify_client tool.
 */

const SHOPIFY_CLIENT_SCHEMA = {
  name: "shopify_client",
  description: [
    "Zero-dependency Shopify Admin REST API client (pure Node.js https; no npm deps).",
    "Auth: provide access_token (OAuth/custom app) OR api_key + api_password (private app).",
    "shop: your Shopify subdomain, e.g. 'my-store' (for my-store.myshopify.com).",
    "Credentials are never returned in output or error messages.",
    "",
    "Operations (27 total):",
    "  Products (6): product_list, product_get, product_create, product_update,",
    "    product_delete, product_count",
    "  Orders (6): order_list, order_get, order_update, order_cancel, order_close, order_count",
    "  Customers (5): customer_list, customer_get, customer_create, customer_update,",
    "    customer_search",
    "  Inventory (3): inventory_level_list, inventory_adjust, inventory_set",
    "  Variants (2): variant_get, variant_update",
    "  Collections (1): collection_list",
    "  Shop & Locations (2): shop_get, location_list",
    "  Generic (1): request",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "all credentials scrubbed from ALL error messages; 16 MB response cap; TLS enforced.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "product_list=list products (paginated); product_get=get product by ID;",
          "product_create=create a new product; product_update=update product fields;",
          "product_delete=delete a product; product_count=count products;",
          "order_list=list orders (filterable by status/financial/fulfillment);",
          "order_get=get order by ID; order_update=update order fields;",
          "order_cancel=cancel an order; order_close=close an order; order_count=count orders;",
          "customer_list=list customers; customer_get=get customer by ID;",
          "customer_create=create a customer; customer_update=update customer;",
          "customer_search=search customers by query string;",
          "inventory_level_list=list inventory levels by item/location IDs;",
          "inventory_adjust=adjust available quantity at a location;",
          "inventory_set=set absolute available quantity at a location;",
          "variant_get=get a product variant by ID; variant_update=update a variant;",
          "collection_list=list custom or smart collections;",
          "shop_get=get shop details (currency, timezone, plan, etc.);",
          "location_list=list all locations;",
          "request=generic HTTP request to any Shopify Admin REST API path.",
        ].join(" "),
        enum: [
          "product_list", "product_get", "product_create", "product_update",
          "product_delete", "product_count",
          "order_list", "order_get", "order_update", "order_cancel",
          "order_close", "order_count",
          "customer_list", "customer_get", "customer_create", "customer_update",
          "customer_search",
          "inventory_level_list", "inventory_adjust", "inventory_set",
          "variant_get", "variant_update",
          "collection_list",
          "shop_get", "location_list",
          "request",
        ],
      },
      // ── Auth & connection ────────────────────────────────────────────────
      shop: {
        type: "string",
        description: "Shopify store subdomain, e.g. 'my-store' (resolves to my-store.myshopify.com). Required.",
      },
      access_token: {
        type: "string",
        description: "Shopify Admin API access token (OAuth / custom app). Use this OR api_key+api_password.",
      },
      api_key: {
        type: "string",
        description: "Private app API key (legacy basic auth). Use with api_password.",
      },
      api_password: {
        type: "string",
        description: "Private app API password / secret key (legacy basic auth). Use with api_key.",
      },
      api_version: {
        type: "string",
        description: "Shopify API version (e.g. '2024-01'). Default: '2024-01'.",
      },
      timeout: {
        type: "integer",
        description: "Request timeout in milliseconds (1000-120000, default 20000).",
        minimum: 1000,
        maximum: 120000,
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS connections with invalid certificates (default true). Set false only for testing.",
      },
      // ── Shared pagination ────────────────────────────────────────────────
      limit: {
        type: "integer",
        description: "Max records to return per page (1-250). Default: Shopify default (50).",
        minimum: 1,
        maximum: 250,
      },
      page_info: {
        type: "string",
        description: "Cursor for paginating through results (from Link header of previous response).",
      },
      since_id: {
        description: "Return records with ID greater than this value.",
      },
      fields: {
        description: "Comma-separated field names to include in the response (string or array of strings).",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      // ── Product fields ────────────────────────────────────────────────────
      product: {
        type: "object",
        description: "Product object for product_create / product_update. Common fields: title, body_html, vendor, product_type, status, variants (array), images (array).",
      },
      status: {
        type: "string",
        description: "Filter by status. For products: 'active','draft','archived'. For orders: 'open','closed','cancelled','any'.",
      },
      vendor: {
        type: "string",
        description: "Filter products by vendor name.",
      },
      product_type: {
        type: "string",
        description: "Filter products by product type.",
      },
      // ── Order fields ──────────────────────────────────────────────────────
      order: {
        type: "object",
        description: "Order object for order_update. Updatable fields include: tags, note, email.",
      },
      financial_status: {
        type: "string",
        description: "Filter orders by financial status: 'pending','authorized','partially_paid','paid','partially_refunded','refunded','voided','any'.",
      },
      fulfillment_status: {
        type: "string",
        description: "Filter orders by fulfillment status: 'shipped','partial','unshipped','any','unfulfilled'.",
      },
      reason: {
        type: "string",
        description: "Cancel reason for order_cancel: 'customer','fraud','inventory','declined','other'.",
      },
      // ── Customer fields ───────────────────────────────────────────────────
      customer: {
        type: "object",
        description: "Customer object for customer_create / customer_update. Common fields: first_name, last_name, email, phone, addresses.",
      },
      query: {
        type: "string",
        description: "Search query for customer_search (Shopify customer search syntax).",
      },
      // ── Inventory fields ──────────────────────────────────────────────────
      inventory_item_id: {
        description: "Inventory item ID (number or string) for inventory operations.",
      },
      location_id: {
        description: "Location ID (number or string) for inventory operations.",
      },
      available_adjustment: {
        type: "number",
        description: "Quantity delta for inventory_adjust (positive to add, negative to subtract).",
      },
      available: {
        type: "number",
        description: "Absolute available quantity for inventory_set.",
      },
      inventory_item_ids: {
        description: "Inventory item IDs (number, string, or array) for inventory_level_list.",
      },
      location_ids: {
        description: "Location IDs (number, string, or array) for inventory_level_list.",
      },
      // ── Variant fields ────────────────────────────────────────────────────
      variant: {
        type: "object",
        description: "Variant object for variant_update. Common fields: price, compare_at_price, sku, inventory_quantity.",
      },
      // ── Collection fields ─────────────────────────────────────────────────
      collection_type: {
        type: "string",
        description: "Collection type for collection_list: 'custom' (default) or 'smart'.",
        enum: ["custom", "smart"],
      },
      // ── Generic request ───────────────────────────────────────────────────
      method: {
        type: "string",
        description: "HTTP method for generic request.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
      },
      path: {
        type: "string",
        description: "API path for generic request (e.g. '/products.json', '/orders/count.json').",
      },
      body: {
        type: "object",
        description: "Request body for generic request (POST/PUT/PATCH).",
      },
      params: {
        type: "object",
        description: "Query parameters for generic request (GET/DELETE).",
      },
      id: {
        description: "Resource ID (number or string) for _get, _update, _delete, _cancel operations.",
      },
    },
    required: ["operation", "shop"],
  },
};

module.exports = { SHOPIFY_CLIENT_SCHEMA };
