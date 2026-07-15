"use strict";
/**
 * utilSchemas118.js
 * JSON Schema for the twilio_client tool.
 */

const TWILIO_CLIENT_SCHEMA = {
  name: "twilio_client",
  description: [
    "Zero-dependency Twilio REST API client (pure Node.js https built-ins; no npm deps).",
    "Auth: account_sid + auth_token (HTTP Basic) OR account_sid + api_key + api_secret.",
    "Credentials are never returned in output or errors.",
    "",
    "Operations (42 total):",
    "  Messages (5): message_send, message_get, message_list, message_delete, message_update",
    "  Calls (5): call_create, call_get, call_list, call_update, call_delete",
    "  Phone Numbers (6): phone_number_list, phone_number_get, phone_number_buy,",
    "    phone_number_update, phone_number_release, phone_number_search",
    "  Recordings (3): recording_list, recording_get, recording_delete",
    "  Verify / OTP (4): verify_service_create, verify_service_list, verify_send, verify_check",
    "  Messaging Services (4): messaging_service_create, messaging_service_get,",
    "    messaging_service_list, messaging_service_delete",
    "  Lookup (1): lookup_phone",
    "  Accounts (3): account_info, sub_account_list, sub_account_create",
    "  Conferences (4): conference_list, conference_get,",
    "    conference_participant_list, conference_participant_kick",
    "  Queues (3): queue_list, queue_create, queue_delete",
    "  Generic (2): request, info",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "credentials (account_sid, auth_token, api_key, api_secret) scrubbed from ALL",
    "error messages; 16 MB response cap; TLS enforced by default.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "message_send=send SMS/MMS/WhatsApp; message_get=fetch message by SID;",
          "message_list=list messages with filters; message_delete=delete message;",
          "message_update=update message body (redact);",
          "call_create=initiate outbound call; call_get=fetch call by SID;",
          "call_list=list calls; call_update=modify live call (hangup/redirect);",
          "call_delete=delete call record;",
          "phone_number_list=list purchased numbers; phone_number_get=fetch number by SID;",
          "phone_number_buy=purchase a phone number; phone_number_update=update number config;",
          "phone_number_release=release (delete) a number; phone_number_search=search available numbers;",
          "recording_list=list recordings; recording_get=fetch recording + download URL;",
          "recording_delete=delete recording;",
          "verify_service_create=create Verify service; verify_service_list=list Verify services;",
          "verify_send=send OTP verification; verify_check=check OTP code;",
          "messaging_service_create=create messaging service; messaging_service_get=fetch messaging service;",
          "messaging_service_list=list messaging services; messaging_service_delete=delete messaging service;",
          "lookup_phone=look up phone number info (carrier, caller name, line type);",
          "account_info=fetch account details; sub_account_list=list sub-accounts;",
          "sub_account_create=create sub-account;",
          "conference_list=list conferences; conference_get=fetch conference;",
          "conference_participant_list=list participants; conference_participant_kick=kick participant;",
          "queue_list=list queues; queue_create=create queue; queue_delete=delete queue;",
          "request=generic HTTP request to any Twilio endpoint; info=connection info.",
        ].join(" "),
        enum: [
          "message_send", "message_get", "message_list", "message_delete", "message_update",
          "call_create", "call_get", "call_list", "call_update", "call_delete",
          "phone_number_list", "phone_number_get", "phone_number_buy",
          "phone_number_update", "phone_number_release", "phone_number_search",
          "recording_list", "recording_get", "recording_delete",
          "verify_service_create", "verify_service_list", "verify_send", "verify_check",
          "messaging_service_create", "messaging_service_get",
          "messaging_service_list", "messaging_service_delete",
          "lookup_phone",
          "account_info", "sub_account_list", "sub_account_create",
          "conference_list", "conference_get",
          "conference_participant_list", "conference_participant_kick",
          "queue_list", "queue_create", "queue_delete",
          "request", "info",
        ],
      },
      account_sid: {
        type: "string",
        description: "Twilio Account SID (ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx). Required for all operations.",
      },
      auth_token: {
        type: "string",
        description: "Twilio Auth Token. Required unless api_key + api_secret is provided. Never returned in output.",
      },
      api_key: {
        type: "string",
        description: "Twilio API Key SID (SKxxxxxxx). Use with api_secret as an alternative to auth_token.",
      },
      api_secret: {
        type: "string",
        description: "Twilio API Key Secret. Required when api_key is provided. Never returned in output.",
      },
      // message_send
      to: {
        type: "string",
        description: "Destination phone number in E.164 format (+15551234567) or WhatsApp number (whatsapp:+15551234567). Required for message_send, call_create, verify_send, verify_check.",
      },
      from: {
        type: "string",
        description: "Sender phone number or messaging service SID. Required for message_send and call_create.",
      },
      body: {
        type: "string",
        description: "Message text body (message_send, message_update) or TwiML body for call_create.",
      },
      media_url: {
        description: "MMS media URL(s). String or array of strings. For message_send.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      status_callback: {
        type: "string",
        description: "URL to receive status callbacks. Used by message_send, call_create, phone_number_buy, phone_number_update.",
      },
      messaging_service_sid: {
        type: "string",
        description: "Messaging Service SID for message_send (use instead of from).",
      },
      content_sid: {
        type: "string",
        description: "Content Template SID for Content API messages (message_send).",
      },
      content_variables: {
        type: "object",
        description: "Variables for Content Template as a JSON object {\"1\": \"value\"} (message_send).",
      },
      max_price: {
        type: "number",
        description: "Maximum price in USD for message delivery (message_send).",
      },
      validity_period: {
        type: "integer",
        description: "Message validity period in seconds 1-14400 (message_send).",
      },
      schedule_type: {
        type: "string",
        description: "Set to 'fixed' to schedule message (message_send).",
      },
      send_at: {
        type: "string",
        description: "ISO 8601 datetime to send scheduled message (message_send with schedule_type=fixed).",
      },
      // message_get, message_delete, message_update
      message_sid: {
        type: "string",
        description: "Message SID (SMxxxxxxx). Required for message_get, message_delete, message_update.",
      },
      // message_list filters
      date_sent: {
        type: "string",
        description: "Filter messages sent on this date YYYY-MM-DD (message_list).",
      },
      date_sent_gte: {
        type: "string",
        description: "Filter messages sent on or after YYYY-MM-DD (message_list).",
      },
      date_sent_lte: {
        type: "string",
        description: "Filter messages sent on or before YYYY-MM-DD (message_list).",
      },
      // call_create
      url: {
        type: "string",
        description: "TwiML URL for call_create. Required unless twiml or application_sid is provided.",
      },
      twiml: {
        type: "string",
        description: "Raw TwiML string for call_create (instead of url).",
      },
      application_sid: {
        type: "string",
        description: "Application SID to handle call (call_create).",
      },
      method: {
        type: "string",
        description: "HTTP method for Twilio to use when calling url (GET or POST). Also used in call_update.",
        enum: ["GET", "POST"],
      },
      fallback_url: {
        type: "string",
        description: "Fallback URL if primary url fails (call_create).",
      },
      record: {
        type: "boolean",
        description: "Whether to record the call (call_create).",
      },
      machine_detection: {
        type: "string",
        description: "Answering machine detection mode (call_create): Enable, DetectMessageEnd.",
        enum: ["Enable", "DetectMessageEnd"],
      },
      // call SID
      call_sid: {
        type: "string",
        description: "Call SID (CAxxxxxxx). Required for call_get, call_update, call_delete, conference_participant_kick.",
      },
      // call_list / message_list
      status: {
        type: "string",
        description: "Status filter for call_list (queued, ringing, in-progress, completed, failed, busy, no-answer) or conference_list (init, in-progress, completed).",
      },
      start_time: {
        type: "string",
        description: "Filter calls by start time YYYY-MM-DD (call_list).",
      },
      // pagination
      page_size: {
        type: "integer",
        description: "Number of records per page (1-1000, default 50). Supported by most list operations.",
        minimum: 1,
        maximum: 1000,
      },
      page_token: {
        type: "string",
        description: "Page token (NextPageUri value) for pagination.",
      },
      // phone numbers
      phone_number_sid: {
        type: "string",
        description: "Incoming Phone Number SID (PNxxxxxxx). Required for phone_number_get, phone_number_update, phone_number_release.",
      },
      phone_number: {
        type: "string",
        description: "Phone number in E.164 format (+15551234567). Required for phone_number_buy and lookup_phone.",
      },
      friendly_name: {
        type: "string",
        description: "Human-readable label. Used by phone_number_buy, phone_number_update, verify_service_create, messaging_service_create, sub_account_create, conference_list, queue_create.",
      },
      sms_url: {
        type: "string",
        description: "Webhook URL for incoming SMS (phone_number_buy, phone_number_update).",
      },
      voice_url: {
        type: "string",
        description: "Webhook URL for incoming voice calls (phone_number_buy, phone_number_update).",
      },
      // phone_number_search
      country_code: {
        type: "string",
        description: "ISO 3166-1 alpha-2 country code (e.g. US, GB, AU). Required for phone_number_search. Optional for lookup_phone.",
      },
      type: {
        type: "string",
        description: "Phone number type for phone_number_search: local (default), toll_free, mobile.",
        enum: ["local", "toll_free", "mobile"],
      },
      area_code: {
        type: "string",
        description: "Area code filter for phone_number_search (US/CA only).",
      },
      contains: {
        type: "string",
        description: "Pattern match for phone number digits (phone_number_search).",
      },
      sms_enabled: {
        type: "boolean",
        description: "Filter by SMS capability (phone_number_search).",
      },
      mms_enabled: {
        type: "boolean",
        description: "Filter by MMS capability (phone_number_search).",
      },
      voice_enabled: {
        type: "boolean",
        description: "Filter by voice capability (phone_number_search).",
      },
      // recordings
      recording_sid: {
        type: "string",
        description: "Recording SID (RExxxxxxx). Required for recording_get, recording_delete.",
      },
      date_created: {
        type: "string",
        description: "Filter recordings/conferences by creation date YYYY-MM-DD.",
      },
      // verify
      service_sid: {
        type: "string",
        description: "Verify Service SID (VAxxxxxxx) for verify_send, verify_check, or Messaging Service SID for messaging_service_get/delete/notify.",
      },
      channel: {
        type: "string",
        description: "Verification channel for verify_send: sms, call, email, whatsapp.",
        enum: ["sms", "call", "email", "whatsapp"],
      },
      code: {
        type: "string",
        description: "OTP code to verify (verify_check).",
      },
      locale: {
        type: "string",
        description: "Language locale for verify OTP (e.g. en, es, fr). verify_send.",
      },
      code_length: {
        type: "integer",
        description: "OTP code length 4-10 digits (verify_service_create, default 6).",
        minimum: 4,
        maximum: 10,
      },
      lookup_enabled: {
        type: "boolean",
        description: "Enable number lookup during verify_send (verify_service_create).",
      },
      // messaging service
      inbound_request_url: {
        type: "string",
        description: "Webhook URL for inbound messages (messaging_service_create).",
      },
      use_inbound_webhook_on_number: {
        type: "boolean",
        description: "Override webhook to use number-level config (messaging_service_create).",
      },
      // lookup
      fields: {
        description: "Extra Lookup fields to fetch: caller_name, sim_swap, call_forwarding, line_status, line_type_intelligence. String or array. (lookup_phone)",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      // conference
      conference_sid: {
        type: "string",
        description: "Conference SID (CFxxxxxxx). Required for conference_get, conference_participant_list, conference_participant_kick.",
      },
      // queue
      queue_sid: {
        type: "string",
        description: "Queue SID (QUxxxxxxx). Required for queue_delete.",
      },
      max_size: {
        type: "integer",
        description: "Maximum queue size 1-1000 (queue_create).",
        minimum: 1,
        maximum: 1000,
      },
      // generic request
      path: {
        type: "string",
        description: "API path for generic request (e.g. /v2/Services or /2010-04-01/Accounts/ACxxx/Messages.json).",
      },
      params: {
        type: "object",
        description: "Query parameters (GET/DELETE) or form-encoded body parameters (POST/PUT) for generic request.",
      },
      // connection
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
    required: ["operation", "account_sid"],
  },
};

module.exports = { TWILIO_CLIENT_SCHEMA };
