"use strict";
/**
 * utilSchemas125.js
 * JSON Schema for the woocommerce_client tool.
 */

const WOOCOMMERCE_CLIENT_SCHEMA = {
  name: "woocommerce_client",
  description: [
    "Zero-dependency WooCommerce REST API v3 client (pure Node.js https; no npm deps).",
    "Auth: Consumer Key + Consumer Secret (HTTP Basic Auth over HTTPS).",
    "site_url: your WordPress site root, e.g. 'https://mystore.example.com' or 'https://example.com/shop'.",
    "Credentials are never returned in output or error messages.",
    "",
    "Operations (32 total):",
    "  Products (7): product_list, product_get, product_create, product_update,",
    "    product_delete, product_count, product_variations",
    "  Orders (7): order_list, order_get, order_create, order_update,",
    "    order_delete, order_count, order_notes",
    "  Customers (6): customer_list, customer_get, customer_create, customer_update,",
    "    customer_delete, customer_count",
    "  Coupons (5): coupon_list, coupon_get, coupon_create, coupon_update, coupon_delete",
    "  Reports (3): report_sales, report_top_sellers, report_orders_totals",
    "  Settings (2): settings_get, settings_update",
    "  System (1): system_status",
    "  Generic (1): request",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "credentials scrubbed from ALL error messages; 16 MB response cap; TLS enforced.",
    "Pagination metadata (_total, _pages) attached from WP-API response headers.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "product_list=list products (filterable/paginated); product_get=get product by ID;",
          "product_create=create product; product_update=update product; product_delete=delete product;",
          "product_count=count products; product_variations=list variations of a variable product;",
          "order_list=list orders (filterable/paginated); order_get=get order by ID;",
          "order_create=create order; order_update=update order; order_delete=delete order;",
          "order_count=count orders; order_notes=list notes for an order;",
          "customer_list=list customers; customer_get=get customer by ID;",
          "customer_create=create customer; customer_update=update customer;",
          "customer_delete=delete customer; customer_count=count customers;",
          "coupon_list=list coupons; coupon_get=get coupon by ID;",
          "coupon_create=create coupon; coupon_update=update coupon; coupon_delete=delete coupon;",
          "report_sales=sales report; report_top_sellers=top-selling products;",
          "report_orders_totals=order totals by status;",
          "settings_get=get settings group; settings_update=update a setting value;",
          "system_status=get WooCommerce system status info;",
          "request=generic HTTP request to any WooCommerce REST API path.",
        ].join(" "),
        enum: [
          "product_list", "product_get", "product_create", "product_update",
          "product_delete", "product_count", "product_variations",
          "order_list", "order_get", "order_create", "order_update",
          "order_delete", "order_count", "order_notes",
          "customer_list", "customer_get", "customer_create", "customer_update",
          "customer_delete", "customer_count",
          "coupon_list", "coupon_get", "coupon_create", "coupon_update", "coupon_delete",
          "report_sales", "report_top_sellers", "report_orders_totals",
          "settings_get", "settings_update",
          "system_status",
          "request",
        ],
      },
      // ── Auth & connection ────────────────────────────────────────────────
      site_url: {
        type: "string",
        description: "WordPress site root URL, e.g. 'https://mystore.example.com' or 'https://example.com/shop'. Required.",
      },
      consumer_key: {
        type: "string",
        description: "WooCommerce REST API Consumer Key (starts with 'ck_'). Required.",
      },
      consumer_secret: {
        type: "string",
        description: "WooCommerce REST API Consumer Secret (starts with 'cs_'). Required.",
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
      // ── Resource ID ──────────────────────────────────────────────────────
      id: {
        description: "Resource ID (number or string) for _get, _update, _delete operations.",
      },
      // ── Shared pagination ────────────────────────────────────────────────
      per_page: {
        type: "integer",
        description: "Number of records per page (1-100, default: WooCommerce default 10).",
        minimum: 1,
        maximum: 100,
      },
      page: {
        type: "integer",
        description: "Page number (1-based).",
        minimum: 1,
      },
      order: {
        type: "string",
        description: "Sort order: 'asc' or 'desc'.",
        enum: ["asc", "desc"],
      },
      orderby: {
        type: "string",
        description: "Sort field (e.g. 'date', 'id', 'title', 'price', 'popularity', 'rating').",
      },
      search: {
        type: "string",
        description: "Keyword search string.",
      },
      // ── Product fields ───────────────────────────────────────────────────
      status: {
        type: "string",
        description: [
          "Filter by status.",
          "Products: 'any','draft','pending','private','publish'.",
          "Orders: 'any','pending','processing','on-hold','completed','cancelled','refunded','failed','trash'.",
          "Customers: role (see role field).",
        ].join(" "),
      },
      type: {
        type: "string",
        description: "Filter products by type: 'simple','grouped','external','variable'.",
        enum: ["simple", "grouped", "external", "variable"],
      },
      category: {
        type: "string",
        description: "Filter products by category ID.",
      },
      product_id: {
        description: "Parent product ID (number or string) for product_variations.",
      },
      // ── Order fields ─────────────────────────────────────────────────────
      customer: {
        type: "string",
        description: "Filter orders by customer ID.",
      },
      product: {
        type: "string",
        description: "Filter orders by product ID.",
      },
      after: {
        type: "string",
        description: "Filter by date after (ISO 8601: 'YYYY-MM-DDTHH:MM:SS').",
      },
      before: {
        type: "string",
        description: "Filter by date before (ISO 8601: 'YYYY-MM-DDTHH:MM:SS').",
      },
      // ── Customer fields ──────────────────────────────────────────────────
      email: {
        type: "string",
        description: "Filter customers by email address.",
      },
      role: {
        type: "string",
        description: "Filter customers by WordPress role (e.g. 'customer','subscriber','all').",
      },
      // ── Coupon fields ────────────────────────────────────────────────────
      code: {
        type: "string",
        description: "Filter coupons by coupon code.",
      },
      // ── Create/Update body ───────────────────────────────────────────────
      data: {
        type: "object",
        description: [
          "Resource data object for create/update operations.",
          "Products: { name, type, status, regular_price, description, categories, images, ... }",
          "Orders: { payment_method, billing, shipping, line_items, ... }",
          "Customers: { email, first_name, last_name, username, password, billing, shipping, ... }",
          "Coupons: { code, discount_type, amount, individual_use, ... }",
        ].join(" "),
      },
      // ── Force delete ─────────────────────────────────────────────────────
      force: {
        type: "boolean",
        description: "Permanently delete instead of trashing (default true). Applies to product_delete, order_delete, customer_delete, coupon_delete.",
      },
      // ── Report fields ────────────────────────────────────────────────────
      period: {
        type: "string",
        description: "Report period: 'week','month','last_month','year'. Used for report_sales and report_top_sellers.",
        enum: ["week", "month", "last_month", "year"],
      },
      date_min: {
        type: "string",
        description: "Report start date (YYYY-MM-DD). Used for report_sales and report_top_sellers.",
      },
      date_max: {
        type: "string",
        description: "Report end date (YYYY-MM-DD). Used for report_sales and report_top_sellers.",
      },
      // ── Settings fields ──────────────────────────────────────────────────
      group: {
        type: "string",
        description: "Settings group ID (e.g. 'general','products','tax','shipping','email','advanced'). Required for settings_update, optional for settings_get.",
      },
      value: {
        description: "New value for settings_update.",
      },
      // ── Generic request ──────────────────────────────────────────────────
      method: {
        type: "string",
        description: "HTTP method for generic request.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
      },
      path: {
        type: "string",
        description: "API path for generic request (e.g. '/products', '/orders/123/refunds'). Relative to /wp-json/wc/v3.",
      },
      body: {
        type: "object",
        description: "Request body for generic request (POST/PUT/PATCH).",
      },
      params: {
        type: "object",
        description: "Query parameters for generic request (GET/DELETE).",
      },
    },
    required: ["operation", "site_url", "consumer_key", "consumer_secret"],
  },
};

module.exports = { WOOCOMMERCE_CLIENT_SCHEMA };
