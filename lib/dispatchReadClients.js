"use strict";
// ── PROTOCOL / FORMAT / CLOUD CLIENT DISPATCH HANDLERS ─────────────────────────
// Extracted from dispatchRead.js when it exceeded the 500-line threshold.
// Contains: websocket, SSE, TCP/UDP, SMTP/IMAP, SSH, Redis, MQTT, AMQP, STOMP,
//           NATS, LDAP, FTP, SNMP, gRPC, Kafka, Memcached, dotenv/TOML/YAML/INI
//           XML/Markdown/CSV/JSONL/HTTP/GraphQL/ZIP/TAR/JSON/Excel/PDF/MsgPack/
//           Protobuf/CBOR/JSONRPC/Avro/Thrift/Parquet/ORC/Arrow/HDF5/PCAP/iCal/
//           SQLite/log/geo/font/epub/audio/video/image/3d/wasm/ssh_keygen,
//           registry, k8s, Prometheus, Elasticsearch, MongoDB, Cassandra,
//           InfluxDB, NTP, Syslog, ClickHouse, Modbus, TLS/CoAP/WHOIS/DNS/IRC/
//           TFTP/RTSP/SIP/XMPP/RADIUS/Diameter/POP3/NNTP/Zookeeper/etcd/Consul/
//           Vault, AWS/GCP/Azure/Terraform, GitHub/GitLab/Bitbucket/Jira/
//           Confluence/Slack/Teams/Notion/Discord/Linear/Zendesk/PagerDuty/
//           Twilio/Stripe/SendGrid/Mailchimp/HubSpot/Salesforce/Shopify/
//           WooCommerce/Airtable, screen_capture.
// Each handler is (args) => result (may return a Promise for async ops).

const { resolveClientPath } = require("./roots");

const { websocketClient } = require("./websocketClientOps");
const { sseClient }       = require("./sseClientOps");
const { tcpClient }       = require("./tcpClientOps");
const { udpClient }       = require("./udpClientOps");
const { sshExec }         = require("./sshExecOps");
const { smtpClient }      = require("./smtpClientOps");
const { imapClient }      = require("./imapClientOps");
const { redisClient }     = require("./redisClientOps");
const { mqttClient }      = require("./mqttClientOps");
const { amqpClient }      = require("./amqpClientOps");
const { stompClient }     = require("./stompClientOps");
const { natsClient }      = require("./natsClientOps");
const { ldapClient }      = require("./ldapClientOps");
const { ftpClient }       = require("./ftpClientOps");
const { snmpClient }      = require("./snmpClientOps");
const { grpcClient }      = require("./grpcClientOps");
const { kafkaClient }     = require("./kafkaClientOps");
const { memcachedClient } = require("./memcachedClientOps");
const { dotenvClient }    = require("./dotenvClientOps");
const { tomlClient }      = require("./tomlClientOps");
const { yamlClient }      = require("./yamlClientOps");
const { iniClient }       = require("./iniClientOps");
const { xmlClient }       = require("./xmlClientOps");
const { markdownClient }  = require("./markdownClientOps");
const { csvClient }       = require("./csvClientOps");
const { jsonlClient }     = require("./jsonlClientOps");
const { httpClient }      = require("./httpClientOps");
const { graphqlClient }   = require("./graphqlClientOps");
const { zipClient }       = require("./zipClientOps");
const { tarClient }       = require("./tarClientOps");
const { jsonClient }      = require("./jsonClientOps");
const { excelClient }     = require("./excelClientOps");
const { pdfClient }       = require("./pdfClientOps");
const { msgpackClient }   = require("./msgpackClientOps");
const { protobufClient }  = require("./protobufClientOps");
const { jsonrpcClient }   = require("./jsonrpcClientOps");
const { avroClient }      = require("./avroClientOps");
const { thriftClient }    = require("./thriftClientOps");
const { parquetClient }   = require("./parquetClientOps");
const { orcClient }       = require("./orcClientOps");
const { arrowClient }     = require("./arrowClientOps");
const { hdf5Client }      = require("./hdf5ClientOps");
const { cborClient }      = require("./cborClientOps");
const { pcapClient }      = require("./pcapClientOps");
const { icalClient }      = require("./icalClientOps");
const { sqliteClient }    = require("./sqliteClientOps");
const { logClient }       = require("./logClientOps");
const { geoClient }       = require("./geoClientOps");
const { fontClient }      = require("./fontClientOps");
const { epubClient }      = require("./epubClientOps");
const { audioClient }     = require("./audioClientOps");
const { videoClient }     = require("./videoClientOps");
const { imageClient }     = require("./imageClientOps");
const { client3d }        = require("./3dClientOps");
const { wasmClient }      = require("./wasmClientOps");
const { sshKeygen }       = require("./sshKeygenOps");
const { registryClient }  = require("./registryClientOps");
const { k8sClient }       = require("./k8sClientOps");
const { prometheusClient } = require("./prometheusClientOps");
const { elasticsearchClient } = require("./elasticsearchClientOps");
const { mongodbClient }       = require("./mongodbClientOps");
const { cassandraClient }     = require("./cassandraClientOps");
const { influxdbClient }      = require("./influxdbClientOps");
const { ntpClient }           = require("./ntpClientOps");
const { syslogClient }        = require("./syslogClientOps");
const { clickhouseClient }    = require("./clickhouseClientOps");
const { modbusClient }        = require("./modbusClientOps");
const { tlsClient }           = require("./tlsClientOps");
const { coapClient }          = require("./coapClientOps");
const { whoisClient }         = require("./whoisClientOps");
const { dnsClient }           = require("./dnsClientOps");
const { ircClient }           = require("./ircClientOps");
const { tftpClient }          = require("./tftpClientOps");
const { rtspClient }          = require("./rtspClientOps");
const { sipClient }           = require("./sipClientOps");
const { xmppClient }          = require("./xmppClientOps");
const { radiusClient }        = require("./radiusClientOps");
const { diameterClient }      = require("./diameterClientOps");
const { pop3Client }          = require("./pop3ClientOps");
const { nntpClient }          = require("./nntpClientOps");
const { zookeeperClient }     = require("./zookeeperClientOps");
const { etcdClient }          = require("./etcdClientOps");
const { consulClient }        = require("./consulClientOps");
const { vaultClient }         = require("./vaultClientOps");
const { awsClient }           = require("./awsClientOps");
const { gcpClient }           = require("./gcpClientOps");
const { azureClient }         = require("./azureClientOps");
const { terraformClient }     = require("./terraformClientOps");
const { githubClient }        = require("./githubClientOps");
const { gitlabClient }        = require("./gitlabClientOps");
const { bitbucketClient }     = require("./bitbucketClientOps");
const { jiraClient }          = require("./jiraClientOps");
const { confluenceClient }    = require("./confluenceClientOps");
const { slackClient }         = require("./slackClientOps");
const { teamsClient }         = require("./teamsClientOps");
const { notionClient }        = require("./notionClientOps");
const { discordClient }       = require("./discordClientOps");
const { linearClient }        = require("./linearClientOps");
const { zendeskClient }       = require("./zendeskClientOps");
const { pagerdutyClient }     = require("./pagerdutyClientOps");
const { twilioClient }        = require("./twilioClientOps");
const { stripeClient }        = require("./stripeClientOps");
const { sendgridClient }      = require("./sendgridClientOps");
const { mailchimpClient }     = require("./mailchimpClientOps");
const { hubspotClient }       = require("./hubspotClientOps");
const { salesforceClient }    = require("./salesforceClientOps");
const { shopifyClient }       = require("./shopifyClientOps");
const { woocommerceClient }   = require("./woocommerceClientOps");
const { airtableClient }      = require("./airtableClientOps");
const { screenCapture }       = require("./screenCaptureOps");

const CLIENTS_DISPATCH = {
  websocket_client(args) {
    // Async — callers in executeTool.js must await the result.
    return websocketClient({
      url:          args.url,
      messages:     args.messages,
      timeout:      args.timeout,
      max_messages: args.max_messages,
      headers:      args.headers,
      subprotocol:  args.subprotocol,
    });
  },

  sse_client(args) {
    // Async — callers in executeTool.js must await the result.
    return sseClient({
      url:           args.url,
      headers:       args.headers,
      timeout:       args.timeout,
      max_events:    args.max_events,
      event_types:   args.event_types,
      last_event_id: args.last_event_id,
    });
  },

  tcp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return tcpClient({
      host:            args.host,
      port:            args.port,
      secure:          args.secure,
      servername:      args.servername,
      messages:        args.messages,
      connect_timeout: args.connect_timeout,
      recv_timeout:    args.recv_timeout,
      timeout:         args.timeout,
      max_recv_bytes:  args.max_recv_bytes,
      max_chunks:      args.max_chunks,
      recv_encoding:   args.recv_encoding,
    });
  },

  udp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return udpClient({
      host:           args.host,
      port:           args.port,
      family:         args.family,
      messages:       args.messages,
      recv_timeout:   args.recv_timeout,
      timeout:        args.timeout,
      max_recv_bytes: args.max_recv_bytes,
      max_datagrams:  args.max_datagrams,
      recv_encoding:  args.recv_encoding,
      bind_port:      args.bind_port,
    });
  },

  smtp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return smtpClient({
      operation:           args.operation,
      host:                args.host,
      port:                args.port,
      secure:              args.secure,
      starttls:            args.starttls,
      reject_unauthorized: args.reject_unauthorized,
      helo_name:           args.helo_name,
      timeout:             args.timeout,
      connect_timeout:     args.connect_timeout,
      auth:                args.auth,
      from:                args.from,
      to:                  args.to,
      cc:                  args.cc,
      bcc:                 args.bcc,
      subject:             args.subject,
      body_text:           args.body_text,
      body_html:           args.body_html,
      extra_headers:       args.extra_headers,
      target:              args.target,
      vrfy_mode:           args.vrfy_mode,
    });
  },

  imap_client(args) {
    // Async — callers in executeTool.js must await the result.
    return imapClient(args);
  },

  ssh_exec(args) {
    // sshExec is synchronous (spawnSync) — no await needed.
    return sshExec({
      operation:                args.operation,
      host:                     args.host,
      user:                     args.user,
      port:                     args.port,
      key_path:                 args.key_path,
      key_data:                 args.key_data,
      strict_host_key_checking: args.strict_host_key_checking,
      timeout:                  args.timeout,
      command:                  args.command,
      local_path:               args.local_path,
      remote_path:              args.remote_path,
      recursive:                args.recursive,
    });
  },

  redis_client(args) {
    // Async — callers in executeTool.js must await the result.
    return redisClient(args);
  },

  mqtt_client(args) {
    // Async — callers in executeTool.js must await the result.
    return mqttClient(args);
  },

  amqp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return amqpClient(args);
  },

  stomp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return stompClient(args);
  },

  nats_client(args) {
    // Async — callers in executeTool.js must await the result.
    return natsClient(args);
  },

  ldap_client(args) {
    // Async — callers in executeTool.js must await the result.
    return ldapClient(args);
  },

  snmp_client(args) {
    // Async - callers in executeTool.js must await the result.
    return snmpClient(args);
  },

  ftp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return ftpClient({
      host:                args.host,
      port:                args.port,
      ftps:                args.ftps,
      reject_unauthorized: args.reject_unauthorized,
      username:            args.username,
      password:            args.password,
      timeout:             args.timeout,
      connect_timeout:     args.connect_timeout,
      operation:           args.operation,
      path:                args.path,
      new_name:            args.new_name,
      data:                args.data,
      encoding:            args.encoding,
      binary:              args.binary,
    });
  },

  kafka_client(args) {
    // Async — callers in executeTool.js must await the result.
    return kafkaClient(args);
  },

  memcached_client(args) {
    // Async — callers in executeTool.js must await the result.
    return memcachedClient(args);
  },

  grpc_client(args) {
    // Async — callers in executeTool.js must await the result.
    return grpcClient(args);
  },

  dotenv_client(args) {
    // Pure sync fs — no await needed.
    return dotenvClient(args);
  },

  toml_client(args) {
    // Pure sync fs — no await needed.
    return tomlClient(args);
  },

  yaml_client(args) {
    // Pure sync fs — no await needed.
    return yamlClient(args);
  },

  ini_client(args) {
    // Pure sync fs — no await needed.
    return iniClient(args);
  },

  xml_client(args) {
    // Pure sync fs — no await needed.
    return xmlClient(args);
  },

  markdown_client(args) {
    // Pure sync fs — no await needed.
    return markdownClient(args);
  },

  csv_client(args) {
    // Pure sync fs — no await needed.
    return csvClient(args);
  },

  jsonl_client(args) {
    // Pure sync fs — no await needed.
    return jsonlClient(args);
  },

  http_client(args) {
    // Async — callers in executeTool.js must await the result.
    return httpClient(args);
  },

  zip_client(args) {
    // Pure sync — no await needed.
    return zipClient(args);
  },

  graphql_client(args) {
    // Async — callers in executeTool.js must await the result.
    return graphqlClient(args);
  },

  tar_client(args) {
    // Pure sync fs — no await needed.
    return tarClient(args);
  },

  json_client(args) {
    // Pure sync fs — no await needed.
    // Normalise: if 'default' key is present, set default_value_set flag so
    // opGet can distinguish an explicit null default from "not provided".
    if (args.default !== undefined) args = { ...args, default_value_set: true };
    return jsonClient(args);
  },

  excel_client(args) {
    // Pure sync fs — no await needed.
    return excelClient(args, resolveClientPath);
  },

  pdf_client(args) {
    // Pure sync fs — no await needed.
    return pdfClient(args, resolveClientPath);
  },

  msgpack_client(args) {
    // Pure sync — no await needed.
    return msgpackClient(args, resolveClientPath);
  },

  protobuf_client(args) {
    // Pure sync — no await needed.
    return protobufClient(args, resolveClientPath);
  },

  cbor_client(args) {
    // Pure sync — no await needed.
    return cborClient(args, resolveClientPath);
  },

  jsonrpc_client(args) {
    // Async — callers in executeTool.js must await the result.
    return jsonrpcClient(args);
  },

  avro_client(args) {
    // Pure sync — no await needed.
    return avroClient(args, resolveClientPath);
  },

  thrift_client(args) {
    // Pure sync — no await needed.
    return thriftClient(args, resolveClientPath);
  },

  parquet_client(args) {
    // Pure sync -- no await needed.
    return parquetClient(args, resolveClientPath);
  },

  orc_client(args) {
    // Pure sync -- no await needed.
    return orcClient(args, resolveClientPath);
  },

  arrow_client(args) {
    // Pure sync -- no await needed.
    return arrowClient(args, resolveClientPath);
  },

  hdf5_client(args) {
    // Pure sync -- no await needed.
    return hdf5Client(args, resolveClientPath);
  },

  pcap_client(args) {
    // Pure sync -- no await needed.
    return pcapClient(args, resolveClientPath);
  },

  ical_client(args) {
    // Pure sync fs -- no await needed.
    return icalClient(args);
  },

  sqlite_client(args) {
    // Pure Node.js read ops; execute op uses spawnSync for sqlite3 CLI.
    return sqliteClient(args);
  },

  log_client(args) {
    // Pure sync fs -- no await needed.
    return logClient(args);
  },

  geo_client(args) {
    // Pure sync fs -- no await needed.
    return geoClient(args);
  },

  font_client(args) {
    // Pure sync fs -- no await needed.
    return fontClient(args);
  },

  epub_client(args) {
    // Pure sync fs -- no await needed.
    return epubClient(args);
  },

  audio_client(args) {
    // Pure sync fs -- no await needed.
    return audioClient(args);
  },

  video_client(args) {
    // Pure sync fs -- no await needed.
    return videoClient(args);
  },

  image_client(args) {
    // Pure sync fs -- no await needed.
    return imageClient(args);
  },

  "3d_client"(args) {
    // Pure sync fs -- no await needed.
    return client3d(args);
  },

  wasm_client(args) {
    // Pure sync fs -- no await needed.
    return wasmClient(args);
  },

  ssh_keygen(args) {
    // Pure sync crypto -- no await needed.
    return sshKeygen(args);
  },

  registry_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return registryClient(args);
  },

  k8s_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return k8sClient(args);
  },

  prometheus_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return prometheusClient(args, resolveClientPath);
  },

  elasticsearch_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return elasticsearchClient(args);
  },

  mongodb_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return mongodbClient(args);
  },

  cassandra_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return cassandraClient(args);
  },

  influxdb_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return influxdbClient(args);
  },

  ntp_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return ntpClient(args);
  },

  syslog_client(args) {
    return syslogClient(args);
  },

  clickhouse_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return clickhouseClient(args);
  },

  modbus_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return modbusClient(args);
  },

  coap_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return coapClient(args);
  },

  whois_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return whoisClient(args);
  },

  tls_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return tlsClient(args);
  },

  dns_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return dnsClient(args);
  },

  irc_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return ircClient(args);
  },

  tftp_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return tftpClient(args);
  },

  rtsp_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return rtspClient(args);
  },

  sip_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return sipClient(args);
  },

  xmpp_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return xmppClient(args);
  },

  radius_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return radiusClient(args);
  },

  diameter_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return diameterClient(args);
  },

  pop3_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return pop3Client(args);
  },

  nntp_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return nntpClient(args);
  },

  zookeeper_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return zookeeperClient(args);
  },

  etcd_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return etcdClient(args);
  },

  consul_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return consulClient(args);
  },

  vault_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return vaultClient(args);
  },

  aws_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return awsClient(args);
  },

  gcp_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return gcpClient(args);
  },

  azure_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return azureClient(args);
  },

  terraform_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return terraformClient(args);
  },

  github_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return githubClient(args);
  },

  gitlab_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return gitlabClient(args);
  },

  bitbucket_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return bitbucketClient(args);
  },

  jira_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return jiraClient(args);
  },

  confluence_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return confluenceClient(args);
  },

  slack_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return slackClient(args);
  },

  teams_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return teamsClient(args);
  },

  notion_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return notionClient(args);
  },

  discord_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return discordClient(args);
  },

  linear_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return linearClient(args);
  },

  zendesk_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return zendeskClient(args);
  },

  pagerduty_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return pagerdutyClient(args);
  },

  twilio_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return twilioClient(args);
  },

  stripe_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return stripeClient(args);
  },

  sendgrid_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return sendgridClient(args);
  },

  mailchimp_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return mailchimpClient(args);
  },

  hubspot_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return hubspotClient(args);
  },

  salesforce_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return salesforceClient(args);
  },

  shopify_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return shopifyClient(args);
  },

  woocommerce_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return woocommerceClient(args);
  },

  airtable_client(args) {
    // Async -- callers in executeTool.js must await the result.
    return airtableClient(args);
  },

  screen_capture(args) {
    // Capture desktop screenshot or control mouse/keyboard.
    // Returns base64 PNG for capture; {ok:true} for input events.
    return screenCapture(args);
  },
};

module.exports = { CLIENTS_DISPATCH };
