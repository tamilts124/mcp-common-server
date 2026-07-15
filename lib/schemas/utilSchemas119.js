"use strict";
/**
 * utilSchemas119.js
 * JSON Schema for the stripe_client tool.
 */

const STRIPE_CLIENT_SCHEMA = {
  name: "stripe_client",
  description: [
    "Zero-dependency Stripe REST API v1 client (pure Node.js https built-ins; no npm deps).",
    "Auth: secret_key (sk_live_* / sk_test_* / rk_* restricted keys) via HTTP Basic (key as username, empty password).",
    "Credentials are never returned in output or errors.",
    "",
    "Operations (63 total):",
    "  Customers (5): customer_create, customer_get, customer_update, customer_delete, customer_list",
    "  Payment Intents (7): payment_intent_create, payment_intent_get, payment_intent_update,",
    "    payment_intent_confirm, payment_intent_capture, payment_intent_cancel, payment_intent_list",
    "  Payment Methods (5): payment_method_create, payment_method_get, payment_method_attach,",
    "    payment_method_detach, payment_method_list",
    "  Charges (4): charge_create, charge_get, charge_capture, charge_list",
    "  Refunds (3): refund_create, refund_get, refund_list",
    "  Subscriptions (5): subscription_create, subscription_get, subscription_update,",
    "    subscription_cancel, subscription_list",
    "  Invoices (6): invoice_create, invoice_get, invoice_finalize, invoice_pay,",
    "    invoice_void, invoice_list",
    "  Products (5): product_create, product_get, product_update, product_delete, product_list",
    "  Prices (3): price_create, price_get, price_list",
    "  Coupons (4): coupon_create, coupon_get, coupon_delete, coupon_list",
    "  Checkout Sessions (4): checkout_session_create, checkout_session_get,",
    "    checkout_session_list, checkout_session_expire",
    "  Webhook Endpoints (5): webhook_endpoint_create, webhook_endpoint_get,",
    "    webhook_endpoint_update, webhook_endpoint_delete, webhook_endpoint_list",
    "  Balance & Payouts (5): balance_get, balance_transaction_list,",
    "    payout_create, payout_get, payout_list",
    "  Disputes (2): dispute_get, dispute_list",
    "  Generic (3): account_info, request, info",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "secret_key scrubbed from ALL error messages; 16 MB response cap; TLS enforced by default.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "customer_create=create customer; customer_get=fetch by ID; customer_update=update fields;",
          "customer_delete=delete; customer_list=list with filters;",
          "payment_intent_create=create PaymentIntent; payment_intent_get=fetch by ID;",
          "payment_intent_update=update; payment_intent_confirm=confirm PI;",
          "payment_intent_capture=capture authorized PI; payment_intent_cancel=cancel;",
          "payment_intent_list=list PIs;",
          "payment_method_create=create PM; payment_method_get=fetch by ID;",
          "payment_method_attach=attach PM to customer; payment_method_detach=detach;",
          "payment_method_list=list PMs for customer;",
          "charge_create=create charge; charge_get=fetch; charge_capture=capture; charge_list=list;",
          "refund_create=create refund; refund_get=fetch; refund_list=list;",
          "subscription_create=create sub; subscription_get=fetch; subscription_update=update;",
          "subscription_cancel=cancel; subscription_list=list;",
          "invoice_create=create invoice; invoice_get=fetch; invoice_finalize=finalize draft;",
          "invoice_pay=pay invoice; invoice_void=void; invoice_list=list;",
          "product_create=create product; product_get=fetch; product_update=update;",
          "product_delete=delete; product_list=list;",
          "price_create=create price; price_get=fetch; price_list=list;",
          "coupon_create=create coupon; coupon_get=fetch; coupon_delete=delete; coupon_list=list;",
          "checkout_session_create=create Checkout Session; checkout_session_get=fetch;",
          "checkout_session_list=list; checkout_session_expire=expire session;",
          "webhook_endpoint_create=create webhook endpoint; webhook_endpoint_get=fetch;",
          "webhook_endpoint_update=update; webhook_endpoint_delete=delete;",
          "webhook_endpoint_list=list;",
          "balance_get=fetch balance; balance_transaction_list=list balance txns;",
          "payout_create=create payout; payout_get=fetch payout; payout_list=list payouts;",
          "dispute_get=fetch dispute; dispute_list=list disputes;",
          "account_info=fetch connected account; request=generic API call; info=connection info.",
        ].join(" "),
        enum: [
          "customer_create", "customer_get", "customer_update", "customer_delete", "customer_list",
          "payment_intent_create", "payment_intent_get", "payment_intent_update",
          "payment_intent_confirm", "payment_intent_capture", "payment_intent_cancel", "payment_intent_list",
          "payment_method_create", "payment_method_get", "payment_method_attach",
          "payment_method_detach", "payment_method_list",
          "charge_create", "charge_get", "charge_capture", "charge_list",
          "refund_create", "refund_get", "refund_list",
          "subscription_create", "subscription_get", "subscription_update",
          "subscription_cancel", "subscription_list",
          "invoice_create", "invoice_get", "invoice_finalize", "invoice_pay",
          "invoice_void", "invoice_list",
          "product_create", "product_get", "product_update", "product_delete", "product_list",
          "price_create", "price_get", "price_list",
          "coupon_create", "coupon_get", "coupon_delete", "coupon_list",
          "checkout_session_create", "checkout_session_get", "checkout_session_list", "checkout_session_expire",
          "webhook_endpoint_create", "webhook_endpoint_get", "webhook_endpoint_update",
          "webhook_endpoint_delete", "webhook_endpoint_list",
          "balance_get", "balance_transaction_list",
          "payout_create", "payout_get", "payout_list",
          "dispute_get", "dispute_list",
          "account_info", "request", "info",
        ],
      },
      secret_key: {
        type: "string",
        description: "Stripe secret key (sk_live_*, sk_test_*, or rk_* restricted key). Required for all operations. Never returned in output.",
      },
      // Shared customer fields
      customer_id: {
        type: "string",
        description: "Stripe Customer ID (cus_*). Required for customer_get/update/delete, payment_method_list, subscription_create, invoice_create.",
      },
      email: {
        type: "string",
        description: "Customer email address. Required for customer_create (optionally). Filter for customer_list.",
      },
      name: {
        type: "string",
        description: "Customer or product name. Used by customer_create/update, product_create/update, coupon_create, queue_create.",
      },
      phone: {
        type: "string",
        description: "Customer phone number. customer_create/update.",
      },
      description: {
        type: "string",
        description: "Human-readable description for many resource types.",
      },
      metadata: {
        type: "object",
        description: "Key-value metadata pairs (up to 50, string values). Supported by most resources.",
      },
      address: {
        type: "object",
        description: "Address object with fields: line1, line2, city, state, postal_code, country. customer_create/update.",
      },
      source: {
        type: "string",
        description: "Legacy card token (tok_*) or source ID for customer_create/update and charge_create.",
      },
      // Payment Intents
      payment_intent_id: {
        type: "string",
        description: "PaymentIntent ID (pi_*). Required for payment_intent_get/update/confirm/capture/cancel.",
      },
      amount: {
        type: "integer",
        description: "Amount in smallest currency unit (e.g. cents for USD). Required for payment_intent_create, charge_create, payout_create.",
        minimum: 1,
      },
      currency: {
        type: "string",
        description: "Three-letter ISO currency code (e.g. usd, eur). Required for payment_intent_create, charge_create, price_create, payout_create.",
      },
      payment_method: {
        type: "string",
        description: "PaymentMethod ID (pm_*). Used by payment_intent_create/update/confirm, customer_create/update, payment_method_attach/detach/get.",
      },
      payment_method_types: {
        type: "array",
        items: { type: "string" },
        description: "List of payment method types (e.g. ['card']). payment_intent_create, checkout_session_create.",
      },
      confirm: {
        type: "boolean",
        description: "Immediately confirm the PaymentIntent on creation. payment_intent_create.",
      },
      capture_method: {
        type: "string",
        description: "Capture method: automatic or manual. payment_intent_create.",
        enum: ["automatic", "manual"],
      },
      setup_future_usage: {
        type: "string",
        description: "Set to 'on_session' or 'off_session' to save payment method. payment_intent_create.",
        enum: ["on_session", "off_session"],
      },
      return_url: {
        type: "string",
        description: "URL to redirect to after payment confirmation. payment_intent_create/confirm.",
      },
      statement_descriptor: {
        type: "string",
        description: "Statement descriptor (up to 22 chars). payment_intent_create, payout_create.",
      },
      receipt_email: {
        type: "string",
        description: "Email to send receipt to. payment_intent_create/update, charge_create.",
      },
      cancellation_reason: {
        type: "string",
        description: "Reason for cancelling a PaymentIntent. payment_intent_cancel.",
        enum: ["duplicate", "fraudulent", "requested_by_customer", "abandoned"],
      },
      amount_to_capture: {
        type: "integer",
        description: "Amount to capture (must be <= original authorized amount). payment_intent_capture.",
      },
      // Payment Methods
      payment_method_id: {
        type: "string",
        description: "PaymentMethod ID (pm_*). Required for payment_method_get/attach/detach.",
      },
      type: {
        type: "string",
        description: "PaymentMethod type (e.g. 'card'). Required for payment_method_create. Also phone number type for phone_number_search (stripe_client: payment method type).",
      },
      card: {
        type: "object",
        description: "Card details object for payment_method_create (type=card): {token: 'tok_...'} or {number, exp_month, exp_year, cvc}.",
      },
      billing_details: {
        type: "object",
        description: "Billing details for payment_method_create: {name, email, phone, address}.",
      },
      // Charges
      charge_id: {
        type: "string",
        description: "Charge ID (ch_*). Required for charge_get, charge_capture.",
      },
      capture: {
        type: "boolean",
        description: "Whether to immediately capture the charge (default true). charge_create.",
      },
      // Refunds
      refund_id: {
        type: "string",
        description: "Refund ID (re_*). Required for refund_get.",
      },
      charge: {
        type: "string",
        description: "Charge ID to refund. refund_create (charge or payment_intent required).",
      },
      payment_intent: {
        type: "string",
        description: "PaymentIntent ID to refund. refund_create (charge or payment_intent required). Also filter for refund_list, dispute_list, checkout_session_list.",
      },
      reason: {
        type: "string",
        description: "Reason for refund: duplicate, fraudulent, or requested_by_customer. refund_create.",
        enum: ["duplicate", "fraudulent", "requested_by_customer"],
      },
      // Subscriptions
      subscription_id: {
        type: "string",
        description: "Subscription ID (sub_*). Required for subscription_get/update/cancel.",
      },
      items: {
        type: "array",
        description: "Subscription line items [{price: 'price_*', quantity?}]. Required for subscription_create. Also used for subscription_update.",
      },
      trial_period_days: {
        type: "integer",
        description: "Number of trial days. subscription_create.",
        minimum: 0,
      },
      payment_behavior: {
        type: "string",
        description: "Payment behavior for subscription_create: default_incomplete, error_if_incomplete, allow_incomplete, pending_if_incomplete.",
      },
      proration_behavior: {
        type: "string",
        description: "Proration behavior: create_prorations, none, always_invoice. subscription_create/update.",
        enum: ["create_prorations", "none", "always_invoice"],
      },
      default_payment_method: {
        type: "string",
        description: "Default payment method for subscription. subscription_create/update.",
      },
      cancel_at_period_end: {
        type: "boolean",
        description: "Cancel subscription at end of billing period. subscription_create/update.",
      },
      collection_method: {
        type: "string",
        description: "Collection method: charge_automatically or send_invoice. subscription_create, invoice_create.",
        enum: ["charge_automatically", "send_invoice"],
      },
      coupon: {
        type: "string",
        description: "Coupon ID to apply. subscription_create/update.",
      },
      invoice_now: {
        type: "boolean",
        description: "Invoice immediately when cancelling subscription. subscription_cancel.",
      },
      prorate: {
        type: "boolean",
        description: "Prorate on subscription cancel. subscription_cancel.",
      },
      trial_end: {
        type: ["string", "integer"],
        description: "Unix timestamp or 'now' to end trial. subscription_update.",
      },
      // Invoices
      invoice_id: {
        type: "string",
        description: "Invoice ID (in_*). Required for invoice_get/finalize/pay/void.",
      },
      auto_advance: {
        type: "boolean",
        description: "Auto-advance invoice to next state. invoice_create.",
      },
      days_until_due: {
        type: "integer",
        description: "Days until invoice is due (for send_invoice collection_method). invoice_create.",
        minimum: 1,
      },
      // Products
      product_id: {
        type: "string",
        description: "Product ID (prod_*). Required for product_get/update/delete.",
      },
      active: {
        type: "boolean",
        description: "Active status. product_create/update/list, price_create/list.",
      },
      images: {
        type: "array",
        items: { type: "string" },
        description: "Array of image URLs (up to 8). product_create/update.",
      },
      // Prices
      price_id: {
        type: "string",
        description: "Price ID (price_*). Required for price_get.",
      },
      product: {
        type: "string",
        description: "Product ID to attach price to. price_create. Also filter for price_list.",
      },
      unit_amount: {
        type: "integer",
        description: "Price in smallest currency unit. price_create.",
        minimum: 0,
      },
      recurring: {
        type: "object",
        description: "Recurring config for price_create: {interval: 'month'|'year'|'week'|'day', interval_count?: number}.",
      },
      nickname: {
        type: "string",
        description: "Internal label for a price. price_create.",
      },
      billing_scheme: {
        type: "string",
        description: "Billing scheme: per_unit or tiered. price_create.",
        enum: ["per_unit", "tiered"],
      },
      tiers: {
        type: "array",
        description: "Pricing tiers array (for tiered billing_scheme). price_create.",
      },
      tiers_mode: {
        type: "string",
        description: "Tiers mode: graduated or volume. price_create.",
        enum: ["graduated", "volume"],
      },
      // Coupons
      coupon_id: {
        type: "string",
        description: "Coupon ID. Required for coupon_get/delete.",
      },
      percent_off: {
        type: "number",
        description: "Percentage discount (0.01-100). coupon_create (percent_off or amount_off required).",
        minimum: 0.01,
        maximum: 100,
      },
      amount_off: {
        type: "integer",
        description: "Fixed discount amount in smallest currency unit. coupon_create (percent_off or amount_off required).",
        minimum: 1,
      },
      duration: {
        type: "string",
        description: "Duration of coupon: forever, once, or repeating. coupon_create.",
        enum: ["forever", "once", "repeating"],
      },
      duration_in_months: {
        type: "integer",
        description: "Number of months coupon applies (when duration=repeating). coupon_create.",
        minimum: 1,
      },
      max_redemptions: {
        type: "integer",
        description: "Maximum number of times coupon can be redeemed. coupon_create.",
        minimum: 1,
      },
      redeem_by: {
        type: "integer",
        description: "Unix timestamp after which coupon can no longer be redeemed. coupon_create.",
      },
      // Checkout Sessions
      session_id: {
        type: "string",
        description: "Checkout Session ID (cs_*). Required for checkout_session_get/expire.",
      },
      mode: {
        type: "string",
        description: "Checkout session mode: payment, setup, or subscription. Required for checkout_session_create.",
        enum: ["payment", "setup", "subscription"],
      },
      success_url: {
        type: "string",
        description: "URL to redirect after successful checkout. Required for checkout_session_create.",
      },
      cancel_url: {
        type: "string",
        description: "URL to redirect on cancelled checkout. checkout_session_create.",
      },
      customer: {
        type: "string",
        description: "Customer ID (cus_*) for checkout_session_create, and as filter for customer_list/charge_list/subscription_list/refund_list/invoice_list/checkout_session_list.",
      },
      customer_email: {
        type: "string",
        description: "Pre-fill customer email in Checkout. checkout_session_create.",
      },
      line_items: {
        type: "array",
        description: "Line items for checkout_session_create: [{price: 'price_*', quantity: N}].",
      },
      subscription_data: {
        type: "object",
        description: "Subscription-level options for checkout_session_create.",
      },
      allow_promotion_codes: {
        type: "boolean",
        description: "Allow customers to enter promotion codes in Checkout. checkout_session_create.",
      },
      // Webhook Endpoints
      webhook_endpoint_id: {
        type: "string",
        description: "Webhook Endpoint ID (we_*). Required for webhook_endpoint_get/update/delete.",
      },
      url: {
        type: "string",
        description: "Webhook endpoint URL. Required for webhook_endpoint_create. Also used for call_create (Twilio, not relevant here).",
      },
      enabled_events: {
        type: "array",
        items: { type: "string" },
        description: "List of event types to listen for (or ['*'] for all). Required for webhook_endpoint_create.",
      },
      disabled: {
        type: "boolean",
        description: "Disable the webhook endpoint. webhook_endpoint_update.",
      },
      // Balance Transactions
      source: {
        type: "string",
        description: "Source ID to filter balance transactions. balance_transaction_list.",
      },
      // Payouts
      payout_id: {
        type: "string",
        description: "Payout ID (po_*). Required for payout_get.",
      },
      method: {
        type: "string",
        description: "Payout method: standard or instant. payout_create.",
        enum: ["standard", "instant"],
      },
      // Disputes
      dispute_id: {
        type: "string",
        description: "Dispute ID (dp_*). Required for dispute_get.",
      },
      // Generic request
      path: {
        type: "string",
        description: "API path for generic 'request' operation (e.g. /v1/customers or /v1/charges/ch_xxx/refunds).",
      },
      params: {
        type: "object",
        description: "Parameters for generic 'request' operation (query string for GET/DELETE, form body for POST/PUT/PATCH).",
      },
      // Shared list parameters
      limit: {
        type: "integer",
        description: "Maximum number of objects to return (1-100, default 10). Supported by all list operations.",
        minimum: 1,
        maximum: 100,
      },
      starting_after: {
        type: "string",
        description: "Cursor for forward pagination: return objects after this ID.",
      },
      ending_before: {
        type: "string",
        description: "Cursor for backward pagination: return objects before this ID.",
      },
      created: {
        type: "object",
        description: "Filter by creation time. Object with gte/lte/gt/lt Unix timestamp properties.",
      },
      // Filters used across different list operations
      status: {
        type: "string",
        description: "Status filter. Meaning varies by resource: subscription (trialing/active/past_due/canceled/unpaid/incomplete), invoice (draft/open/paid/void/uncollectible), payout (pending/paid/failed/canceled), charge (succeeded/pending/failed), dispute (warning_needs_response/needs_response/under_review/charge_refunded/won/lost), payment_intent (requires_payment_method/requires_confirmation/requires_action/processing/requires_capture/canceled/succeeded).",
      },
      price: {
        type: "string",
        description: "Price ID to filter subscription_list.",
      },
      subscription: {
        type: "string",
        description: "Subscription ID (sub_*) filter for invoice_list, checkout_session_list.",
      },
      // Generic API request method
      // (reuses 'method' key)
      // Stripe Connect (optional)
      stripe_account: {
        type: "string",
        description: "Stripe-Account header for Connect — perform operations on behalf of a connected account.",
      },
      idempotency_key: {
        type: "string",
        description: "Idempotency key (up to 255 chars) for safe retries on POST requests.",
      },
      expand: {
        type: "array",
        items: { type: "string" },
        description: "List of fields to expand inline (e.g. ['latest_invoice', 'customer']). Supported where Stripe API allows.",
      },
      // Connection
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
    },
    required: ["operation", "secret_key"],
  },
};

module.exports = { STRIPE_CLIENT_SCHEMA };
