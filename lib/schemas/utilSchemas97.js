"use strict";

const nntpClientSchema = {
  name: "nntp_client",
  description: "Zero-dependency NNTP (Network News Transfer Protocol) client (pure Node.js net/tls built-ins; no npm deps). Implements RFC 977 (original NNTP), RFC 3977 (modern NNTP revision), RFC 2980 (common extensions: XOVER, XHDR), and RFC 4644 (streaming). NNTP is the protocol for Usenet newsgroups — the decentralized discussion system predating the web. Use for: reading/posting news articles, browsing newsgroup hierarchies, testing NNTP server deployments (INN, Leafnode, Diablo, Eternal September, news.mixmin.net), or archiving newsgroup content. Operations: capabilities (CAPABILITIES — list server extensions and supported features), list_groups (LIST ACTIVE / LIST NEWSGROUPS — enumerate available newsgroups with optional wildmat pattern filter), group (GROUP — select a newsgroup and return its article count and first/last article numbers), list_articles (OVER/XOVER — retrieve article overview data: subject/from/date/message-ID for articles in range; or LISTGROUP for just article numbers), article (ARTICLE — download full article headers + body by message-ID or article number), head (HEAD — retrieve only headers), body (BODY — retrieve only body), post (POST — submit a new article to one or more newsgroups), date (DATE — query server's current UTC date/time, RFC 3977), quit (QUIT — graceful disconnect), info (return protocol/command reference table, no I/O). Transport: plain TCP port 119 (default) or TLS (NNTPS) port 563 (use_tls: true). Authentication: AUTHINFO USER/PASS (RFC 4643) — provided automatically when username+password given.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["capabilities", "list_groups", "group", "list_articles", "article", "head", "body", "post", "date", "quit", "info"],
        description: "Operation to perform. capabilities=CAPABILITIES (server features). list_groups=LIST ACTIVE or LIST NEWSGROUPS. group=GROUP (select newsgroup). list_articles=OVER/XOVER overview or LISTGROUP article numbers. article=ARTICLE (full). head=HEAD (headers only). body=BODY (body only). post=POST (submit article). date=DATE (server time). quit=QUIT graceful close. info=protocol reference (no I/O).",
      },
      host: {
        type: "string",
        description: "NNTP server hostname or IP. Required for all operations except info. E.g. 'news.eternal-september.org', 'nntp.aioe.org', 'localhost'.",
      },
      port: {
        type: "number",
        description: "TCP port (default: 119 plain, 563 TLS). Range: 1-65535.",
      },
      use_tls: {
        type: "boolean",
        description: "Connect with TLS (NNTPS) on port 563. Default: false.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS connections with invalid/self-signed certificates. Default: true. Set false for test servers.",
      },
      username: {
        type: "string",
        description: "NNTP username for AUTHINFO USER/PASS authentication. Optional if server permits anonymous access.",
      },
      password: {
        type: "string",
        description: "NNTP password. Never logged or returned in results.",
      },
      timeout: {
        type: "number",
        description: "Connection + per-command timeout in milliseconds (default: 15000, range: 1000-120000).",
      },
      group: {
        type: "string",
        description: "Newsgroup name for group, list_articles, article, head, body operations. E.g. 'comp.lang.javascript', 'alt.test', 'rec.humor'.",
      },
      list_type: {
        type: "string",
        enum: ["active", "descriptions"],
        description: "For list_groups: 'active' (LIST ACTIVE — group name + first/last/flag) or 'descriptions' (LIST NEWSGROUPS — group name + description). Default: 'active'.",
      },
      pattern: {
        type: "string",
        description: "Wildmat pattern for list_groups to filter results. E.g. 'comp.lang.*', 'alt.binaries.*'. Uses NNTP wildmat syntax (RFC 2980 §2.1.2).",
      },
      max_groups: {
        type: "number",
        description: "Maximum number of newsgroups to return for list_groups (default: 5000, max: 50000). Servers can have 100k+ groups.",
      },
      first: {
        type: "number",
        description: "First article number in range for list_articles. Inclusive. If omitted, uses server default (usually current article).",
      },
      last: {
        type: "number",
        description: "Last article number in range for list_articles. Inclusive. If omitted, uses 'first-' (open-ended range).",
      },
      max_articles: {
        type: "number",
        description: "Maximum number of articles to return for list_articles (default: 500, max: 5000).",
      },
      overview: {
        type: "boolean",
        description: "For list_articles: if true (default), use OVER/XOVER to return subject/from/date/size metadata. If false, use LISTGROUP for article numbers only.",
      },
      message_id: {
        type: "string",
        description: "Message-ID for article/head/body operations. Include or omit angle brackets — both forms accepted. E.g. 'abc123@news.example.com' or '<abc123@news.example.com>'.",
      },
      article_num: {
        type: "number",
        description: "Article number within currently selected group (requires prior group selection or 'group' param). Range: 1-999999999.",
      },
      parse_headers: {
        type: "boolean",
        description: "For article and head: parse RFC 2822 headers into a structured object. Default: true.",
      },
      newsgroups: {
        type: "string",
        description: "Comma-separated list of newsgroups for the post operation. E.g. 'alt.test', 'comp.lang.javascript,comp.lang.python'.",
      },
      subject: {
        type: "string",
        description: "Subject line for post operation.",
      },
      from: {
        type: "string",
        description: "From address for post operation. E.g. 'User Name <user@example.com>'.",
      },
      body: {
        type: "string",
        description: "Article body text for post operation.",
      },
      extra_headers: {
        type: "object",
        description: "Additional RFC 2822 headers for post as key-value pairs. E.g. {\"Organization\": \"Example Corp\", \"X-Custom-Header\": \"value\"}.",
        additionalProperties: { type: "string" },
      },
    },
  },
};

module.exports = { nntpClientSchema };
