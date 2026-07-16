"use strict";
/**
 * utilSchemas121.js
 * JSON Schema for the mailchimp_client tool.
 */

const MAILCHIMP_CLIENT_SCHEMA = {
  name: "mailchimp_client",
  description: [
    "Zero-dependency Mailchimp Marketing API v3 client (pure Node.js https; no npm deps).",
    "Auth: api_key (Basic auth, key ends in -usXX datacenter) or oauth_token (Bearer).",
    "Credentials are never returned in output or errors.",
    "",
    "Operations (49 total):",
    "  Lists/Audiences (6): list_create, list_get, list_get_all, list_update, list_delete, list_stats",
    "  Members (8): member_add, member_upsert, member_get, member_update, member_delete,",
    "    member_delete_permanent, member_list, member_tags_update",
    "  Segments (6): segment_create, segment_get, segment_list, segment_delete,",
    "    segment_member_add, segment_member_delete",
    "  Campaigns (13): campaign_create, campaign_get, campaign_list, campaign_update,",
    "    campaign_delete, campaign_send, campaign_schedule, campaign_unschedule,",
    "    campaign_send_test, campaign_cancel, campaign_replicate,",
    "    campaign_content_get, campaign_content_set",
    "  Templates (5): template_create, template_get, template_list, template_update, template_delete",
    "  Reports (5): report_get, report_list, report_click_details,",
    "    report_open_details, report_unsubscribes",
    "  Automations (6): automation_list, automation_get, automation_start, automation_pause,",
    "    automation_email_list, automation_subscriber_add",
    "  Ping/Info (2): ping, account_info",
    "  Generic (1): request",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "api_key/oauth_token scrubbed from ALL error messages; 16 MB response cap; TLS enforced.",
    "Member operations use MD5 hash of lowercase email as Mailchimp member ID.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "list_create=create a new audience/list (requires contact info, from details);",
          "list_get=get list by ID; list_get_all=list all audiences;",
          "list_update=update list settings; list_delete=delete a list;",
          "list_stats=get list growth history;",
          "member_add=add a new subscriber (fails if already exists);",
          "member_upsert=add or update subscriber (PUT, idempotent);",
          "member_get=get subscriber info by email;",
          "member_update=update subscriber details;",
          "member_delete=archive a subscriber;",
          "member_delete_permanent=permanently delete a subscriber;",
          "member_list=list subscribers in an audience;",
          "member_tags_update=add/remove tags from a subscriber;",
          "segment_create=create a static/saved segment;",
          "segment_get=get segment by ID; segment_list=list segments in a list;",
          "segment_delete=delete a segment;",
          "segment_member_add=add a member to a static segment;",
          "segment_member_delete=remove a member from a static segment;",
          "campaign_create=create a campaign; campaign_get=get campaign by ID;",
          "campaign_list=list campaigns; campaign_update=update campaign settings;",
          "campaign_delete=delete campaign; campaign_send=send immediately;",
          "campaign_schedule=schedule send at a specific time;",
          "campaign_unschedule=cancel scheduling; campaign_send_test=send test emails;",
          "campaign_cancel=cancel a sending campaign;",
          "campaign_replicate=duplicate a campaign;",
          "campaign_content_get=get campaign HTML/text; campaign_content_set=set campaign content;",
          "template_create=create an email template; template_get=get template by ID;",
          "template_list=list templates; template_update=update template;",
          "template_delete=delete template;",
          "report_get=get campaign report; report_list=list reports;",
          "report_click_details=click URL stats; report_open_details=open stats per subscriber;",
          "report_unsubscribes=list unsubscribes for a campaign;",
          "automation_list=list classic automations;",
          "automation_get=get automation by workflow ID;",
          "automation_start=start all emails in an automation;",
          "automation_pause=pause all emails; automation_email_list=list automation emails;",
          "automation_subscriber_add=add subscriber to automation queue;",
          "ping=test API connectivity; account_info=get account details;",
          "request=generic HTTP request to any Mailchimp API path.",
        ].join(" "),
        enum: [
          "list_create", "list_get", "list_get_all", "list_update", "list_delete", "list_stats",
          "member_add", "member_upsert", "member_get", "member_update", "member_delete",
          "member_delete_permanent", "member_list", "member_tags_update",
          "segment_create", "segment_get", "segment_list", "segment_delete",
          "segment_member_add", "segment_member_delete",
          "campaign_create", "campaign_get", "campaign_list", "campaign_update", "campaign_delete",
          "campaign_send", "campaign_schedule", "campaign_unschedule", "campaign_send_test",
          "campaign_cancel", "campaign_replicate", "campaign_content_get", "campaign_content_set",
          "template_create", "template_get", "template_list", "template_update", "template_delete",
          "report_get", "report_list", "report_click_details", "report_open_details", "report_unsubscribes",
          "automation_list", "automation_get", "automation_start", "automation_pause",
          "automation_email_list", "automation_subscriber_add",
          "ping", "account_info", "request",
        ],
      },
      api_key: {
        type: "string",
        description: "Mailchimp API key ending in -usXX (e.g. 'abc123-us6'). Datacenter is extracted automatically. Mutually exclusive with oauth_token.",
      },
      oauth_token: {
        type: "string",
        description: "Mailchimp OAuth2 access token. Requires server_prefix when used. Mutually exclusive with api_key.",
      },
      server_prefix: {
        type: "string",
        description: "Mailchimp server prefix (datacenter), e.g. 'us6'. Auto-extracted from api_key. Required when using oauth_token.",
      },
      // List fields
      list_id: {
        type: "string",
        description: "Audience/list ID. Required for list_get, list_update, list_delete, list_stats, member_*, segment_*, and campaign list targeting.",
      },
      name: {
        type: "string",
        description: "Name for list_create, list_update, segment_create, template_create, template_update.",
      },
      company: {
        type: "string",
        description: "Company name for list_create contact block (required by CAN-SPAM).",
      },
      address1: {
        type: "string",
        description: "Street address line 1 for list_create (required).",
      },
      address2: {
        type: "string",
        description: "Street address line 2 for list_create.",
      },
      city: {
        type: "string",
        description: "City for list_create (required).",
      },
      state: {
        type: "string",
        description: "State/province for list_create.",
      },
      zip: {
        type: "string",
        description: "Postal code for list_create.",
      },
      country: {
        type: "string",
        description: "Two-letter country code for list_create (required), e.g. 'US'.",
      },
      phone: {
        type: "string",
        description: "Phone number for list_create contact block.",
      },
      permission_reminder: {
        type: "string",
        description: "Remind subscribers why they signed up (list_create required). E.g. 'You signed up on our website.'",
      },
      from_name: {
        type: "string",
        description: "Default 'from' display name for campaigns (list_create campaign_defaults, required).",
      },
      from_email: {
        type: "string",
        description: "Default 'from' email for campaigns (list_create campaign_defaults, required).",
      },
      subject: {
        type: "string",
        description: "Default email subject for campaigns (list_create campaign_defaults, required).",
      },
      language: {
        type: "string",
        description: "Default language code for list (e.g. 'en'). Also used in member_add/member_upsert.",
      },
      email_type_option: {
        type: "boolean",
        description: "Allow subscribers to choose HTML or plaintext (list_create). Default: false.",
      },
      double_optin: {
        type: "boolean",
        description: "Require double opt-in confirmation (list_create). Default: true.",
      },
      contact: {
        type: "object",
        description: "Contact block for list_update: {company, address1, address2, city, state, zip, country, phone}.",
      },
      campaign_defaults: {
        type: "object",
        description: "Campaign defaults for list_update: {from_name, from_email, subject, language}.",
      },
      // Member fields
      email_address: {
        type: "string",
        description: "Subscriber email address. Required for member_add, member_upsert, member_get, member_update, member_delete, member_delete_permanent, member_tags_update, segment_member_add, segment_member_delete, automation_subscriber_add.",
      },
      status: {
        type: "string",
        description: "Subscriber status for member_add (required): 'subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional'. Also used in member_update and member_list filtering.",
        enum: ["subscribed", "unsubscribed", "cleaned", "pending", "transactional"],
      },
      status_if_new: {
        type: "string",
        description: "Status to set when creating a new subscriber via member_upsert. Required for member_upsert.",
        enum: ["subscribed", "unsubscribed", "cleaned", "pending", "transactional"],
      },
      email_type: {
        type: "string",
        description: "Email format preference: 'html' or 'text' (member_add/member_upsert/member_update).",
        enum: ["html", "text"],
      },
      merge_fields: {
        type: "object",
        description: "Merge field values for member operations, e.g. {FNAME: 'Alice', LNAME: 'Smith'}.",
      },
      interests: {
        type: "object",
        description: "Interest group IDs mapped to boolean (member_add/member_upsert/member_update), e.g. {groupId: true}.",
      },
      vip: {
        type: "boolean",
        description: "Mark subscriber as VIP (member_add/member_upsert/member_update).",
      },
      location: {
        type: "object",
        description: "Subscriber location: {latitude, longitude} (member_add/member_upsert/member_update).",
        properties: {
          latitude:  { type: "number" },
          longitude: { type: "number" },
        },
      },
      tags: {
        type: "array",
        description: "Tags for member_add (array of strings), or for member_tags_update (array of {name, status: 'active'|'inactive'} objects).",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                name:   { type: "string" },
                status: { type: "string", enum: ["active", "inactive"] },
              },
              required: ["name", "status"],
            },
          ],
        },
      },
      since_timestamp_opt: {
        type: "string",
        description: "Filter member_list by opt-in date >= this ISO 8601 datetime (e.g. '2024-01-01T00:00:00Z').",
      },
      before_timestamp_opt: {
        type: "string",
        description: "Filter member_list by opt-in date <= this ISO 8601 datetime.",
      },
      // Segment fields
      segment_id: {
        type: "integer",
        description: "Segment ID. Required for segment_get, segment_delete, segment_member_add, segment_member_delete.",
      },
      static_segment: {
        type: "array",
        items: { type: "string" },
        description: "List of email addresses for a static segment (segment_create).",
      },
      options: {
        type: "object",
        description: "Saved segment conditions for segment_create (advanced, Mailchimp API conditions format).",
      },
      type: {
        type: "string",
        description: "Filter by type in segment_list ('static', 'saved', 'fuzzy'), campaign_list ('regular', 'plaintext', 'absplit', 'rss', 'variate'), template_list, or report_list.",
      },
      // Campaign fields
      campaign_id: {
        type: "string",
        description: "Campaign ID. Required for campaign_get, campaign_update, campaign_delete, campaign_send, campaign_schedule, campaign_unschedule, campaign_send_test, campaign_cancel, campaign_replicate, campaign_content_get, campaign_content_set, report_*.",
      },
      recipients: {
        type: "object",
        description: "Campaign recipients config (campaign_create/update): {list_id, segment_opts?: {saved_segment_id, match, conditions}}.",
        properties: {
          list_id:      { type: "string" },
          segment_opts: { type: "object" },
        },
      },
      settings: {
        type: "object",
        description: "Campaign settings (campaign_create/update): {subject_line, preview_text?, title?, from_name, reply_to, use_conversation?, to_name?, folder_id?, authenticate?, auto_footer?, inline_css?, auto_tweet?, fb_comments?, template_id?}.",
      },
      variate_settings: {
        type: "object",
        description: "A/B test settings for variate campaigns (campaign_create).",
      },
      tracking: {
        type: "object",
        description: "Campaign tracking options (campaign_create/update): {opens, html_clicks, text_clicks, goal_tracking?, ecomm360?, google_analytics?, clicktale?}.",
      },
      rss_opts: {
        type: "object",
        description: "RSS campaign options (campaign_create/update): {feed_url, frequency, constrain_rss_img?, schedule?: {hour, weekly_send_day?, monthly_send_date?}}.",
      },
      social_card: {
        type: "object",
        description: "Social card options (campaign_create/update): {image_url, description, title}.",
      },
      schedule_time: {
        type: "string",
        description: "ISO 8601 datetime to schedule campaign send (campaign_schedule), e.g. '2024-12-01T10:00:00Z'.",
      },
      timewarp: {
        type: "boolean",
        description: "Use Timewarp to send by subscriber's local time (campaign_schedule).",
      },
      batch_delivery: {
        type: "object",
        description: "Batch delivery config for campaign_schedule: {batch_delay, batch_count}.",
      },
      test_emails: {
        type: "array",
        items: { type: "string" },
        description: "Email addresses to receive test campaign (campaign_send_test, required).",
      },
      send_type: {
        type: "string",
        description: "Type of test email: 'html' or 'plaintext' (campaign_send_test).",
        enum: ["html", "plaintext"],
      },
      // Campaign content fields
      plain_text: {
        type: "string",
        description: "Plain text email body (campaign_content_set).",
      },
      html: {
        type: "string",
        description: "HTML email body (campaign_content_set, template_create, template_update).",
      },
      url: {
        type: "string",
        description: "URL to import content from (campaign_content_set).",
      },
      template: {
        type: "object",
        description: "Template reference for campaign_content_set: {id, sections?}.",
      },
      sections: {
        type: "object",
        description: "Template section content for campaign_content_set: {section_id: html_content}.",
      },
      // Template fields
      template_id: {
        type: "integer",
        description: "Template ID. Required for template_get, template_update, template_delete.",
      },
      category: {
        type: "string",
        description: "Template category filter for template_list.",
      },
      folder_id: {
        type: "string",
        description: "Folder ID for template_create/template_update.",
      },
      // Report filters
      since_send_time: {
        type: "string",
        description: "Filter report_list by send time >= ISO 8601 datetime.",
      },
      before_send_time: {
        type: "string",
        description: "Filter report_list by send time <= ISO 8601 datetime.",
      },
      since: {
        type: "string",
        description: "Filter report_open_details to opens since this ISO 8601 datetime.",
      },
      // Automation
      workflow_id: {
        type: "string",
        description: "Automation workflow ID. Required for automation_get, automation_start, automation_pause, automation_email_list, automation_subscriber_add.",
      },
      // Generic request
      method: {
        type: "string",
        description: "HTTP method for generic request: GET, POST, PUT, PATCH, DELETE.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description: "API path for generic request (without /3.0 prefix, e.g. '/lists', '/campaigns/abc123/content').",
      },
      body: {
        type: "object",
        description: "Request body for generic request (POST/PUT/PATCH).",
      },
      params: {
        type: "object",
        description: "Query parameters for generic request (GET/DELETE).",
      },
      // Pagination
      count: {
        type: "integer",
        description: "Number of records to return (max 1000). Used by list_get_all, member_list, segment_list, campaign_list, template_list, report_list, report_click_details, report_open_details, report_unsubscribes.",
        minimum: 1,
        maximum: 1000,
      },
      offset: {
        type: "integer",
        description: "Pagination offset (0-based). Used by same operations as count.",
        minimum: 0,
      },
      sort_field: {
        type: "string",
        description: "Sort field for list_get_all ('date_created', 'campaign_count', 'member_count') or campaign_list ('create_time', 'send_time').",
      },
      sort_dir: {
        type: "string",
        description: "Sort direction: 'ASC' or 'DESC'.",
        enum: ["ASC", "DESC"],
      },
      since_create_time: {
        type: "string",
        description: "Filter campaign_list by creation time >= ISO 8601 datetime.",
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
    required: ["operation"],
  },
};

module.exports = { MAILCHIMP_CLIENT_SCHEMA };
