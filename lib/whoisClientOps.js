"use strict";
/**
 * whois_client — Zero-dependency WHOIS client.
 * Pure Node.js (net built-in; no npm deps).
 *
 * Implements the WHOIS protocol per RFC 3912 over TCP port 43.
 * Supports:
 *   domain  — Query a domain name (routes to the correct TLD WHOIS server)
 *   ip      — Query an IP address (routes via ARIN, then follows referrals)
 *   asn     — Query an Autonomous System Number
 *   tld     — Query a TLD directly at whois.iana.org
 *   raw     — Raw query to an explicit WHOIS server
 *   info    — Return built-in routing table and config info (no I/O)
 *
 * Security:
 *   - NUL-byte guards on all user-supplied strings
 *   - Timeout clamped 1 s – 30 s
 *   - Response capped at 128 KB
 *   - Port must be 1–65535 (default 43)
 *   - Referral depth capped at 3 hops
 *   - No credentials involved
 */

const net    = require("net");
const crypto = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS  = 10_000;   // 10 s
const MIN_TIMEOUT_MS      = 1_000;
const MAX_TIMEOUT_MS      = 30_000;
const MAX_RESPONSE_BYTES  = 128 * 1024;   // 128 KB
const WHOIS_PORT          = 43;
const MAX_REFERRAL_DEPTH  = 3;
const IANA_WHOIS          = "whois.iana.org";
const ARIN_WHOIS          = "whois.arin.net";

// ── Well-known TLD → WHOIS server map ────────────────────────────────────────
// Common TLDs; IANA bootstrap covers the rest via whois.iana.org referrals.
const TLD_SERVERS = {
  // gTLDs
  com:     "whois.verisign-grs.com",
  net:     "whois.verisign-grs.com",
  org:     "whois.pir.org",
  info:    "whois.afilias.net",
  biz:     "whois.biz",
  mobi:    "whois.dotmobiregistry.net",
  name:    "whois.nic.name",
  pro:     "whois.registrypro.pro",
  aero:    "whois.aero",
  coop:    "whois.nic.coop",
  museum:  "whois.museum",
  travel:  "whois.nic.travel",
  jobs:    "whois.nic.jobs",
  tel:     "whois.nic.tel",
  cat:     "whois.cat",
  post:    "whois.dotpostregistry.net",
  xxx:     "whois.nic.xxx",
  edu:     "whois.educause.edu",
  gov:     "whois.dotgov.gov",
  mil:     "whois.nic.mil",
  int:     "whois.iana.org",
  arpa:    "whois.iana.org",
  // New gTLDs (sample)
  app:     "whois.nic.google",
  dev:     "whois.nic.google",
  web:     "whois.nic.web",
  shop:    "whois.nic.shop",
  online:  "whois.nic.online",
  site:    "whois.nic.site",
  tech:    "whois.nic.tech",
  store:   "whois.nic.store",
  blog:    "whois.nic.blog",
  cloud:   "whois.nic.cloud",
  // ccTLDs
  ac:      "whois.nic.ac",
  ad:      "whois.ripe.net",
  ae:      "whois.aeda.net.ae",
  af:      "whois.nic.af",
  ag:      "whois.nic.ag",
  ai:      "whois.nic.ai",
  al:      "whois.ripe.net",
  am:      "whois.amnic.net",
  ao:      "whois.dns.pt",
  ar:      "whois.nic.ar",
  as:      "whois.nic.as",
  at:      "whois.nic.at",
  au:      "whois.auda.org.au",
  aw:      "whois.nic.aw",
  ax:      "whois.ax",
  az:      "whois.ripe.net",
  ba:      "whois.ripe.net",
  bb:      "whois.telecoms.gov.bb",
  bd:      "whois.btcl.net.bd",
  be:      "whois.dns.be",
  bf:      "whois.registre.bf",
  bg:      "whois.register.bg",
  bh:      "whois.nic.bh",
  bi:      "whois.nic.bi",
  bj:      "whois.nic.bj",
  bm:      "whois.afilias-srs.net",
  bn:      "whois.bn",
  bo:      "whois.nic.bo",
  br:      "whois.registro.br",
  bs:      "whois.nic.bs",
  bt:      "whois.nic.bt",
  bw:      "whois.nic.net.bw",
  by:      "whois.cctld.by",
  bz:      "whois.belizenic.bz",
  ca:      "whois.cira.ca",
  cc:      "ccwhois.verisign-grs.com",
  cd:      "whois.nic.cd",
  cf:      "whois.dot.cf",
  cg:      "whois.nic.cg",
  ch:      "whois.nic.ch",
  ci:      "whois.nic.ci",
  ck:      "whois.nic.ck",
  cl:      "whois.nic.cl",
  cm:      "whois.netcom.cm",
  cn:      "whois.cnnic.cn",
  co:      "whois.nic.co",
  cr:      "whois.nic.cr",
  cu:      "whois.nic.cu",
  cv:      "whois.nic.cv",
  cx:      "whois.nic.cx",
  cy:      "whois.ripe.net",
  cz:      "whois.nic.cz",
  de:      "whois.denic.de",
  dj:      "whois.nic.dj",
  dk:      "whois.dk-hostmaster.dk",
  dm:      "whois.nic.dm",
  do:      "whois.nic.do",
  dz:      "whois.nic.dz",
  ec:      "whois.nic.ec",
  ee:      "whois.tld.ee",
  eg:      "whois.ripe.net",
  er:      "whois.ripe.net",
  es:      "whois.nic.es",
  et:      "whois.ripe.net",
  eu:      "whois.eu",
  fi:      "whois.fi",
  fj:      "whois.domainregistry.net.fj",
  fk:      "whois.nic.fk",
  fm:      "whois.nic.fm",
  fo:      "whois.nic.fo",
  fr:      "whois.nic.fr",
  ga:      "whois.dot.ga",
  gb:      "whois.ripe.net",
  gd:      "whois.nic.gd",
  ge:      "whois.ripe.net",
  gf:      "whois.nic.fr",
  gg:      "whois.gg",
  gh:      "whois.nic.gh",
  gi:      "whois2.afilias-grs.net",
  gl:      "whois.nic.gl",
  gm:      "whois.nic.gm",
  gn:      "whois.nic.gn",
  gp:      "whois.nic.fr",
  gq:      "whois.dominio.gq",
  gr:      "whois.ripe.net",
  gs:      "whois.nic.gs",
  gt:      "whois.gt",
  gu:      "whois.nic.gu",
  gw:      "whois.nic.gw",
  gy:      "whois.registry.gy",
  hk:      "whois.hkdnr.net.hk",
  hm:      "whois.registry.hm",
  hn:      "whois.nic.hn",
  hr:      "whois.dns.hr",
  ht:      "whois.nic.ht",
  hu:      "whois.nic.hu",
  id:      "whois.id",
  ie:      "whois.domainregistry.ie",
  il:      "whois.isoc.org.il",
  im:      "whois.nic.im",
  in:      "whois.registry.in",
  io:      "whois.nic.io",
  iq:      "whois.cmc.iq",
  ir:      "whois.nic.ir",
  is:      "whois.isnic.is",
  it:      "whois.nic.it",
  je:      "whois.je",
  jm:      "whois.com",
  jo:      "whois.jo",
  jp:      "whois.jprs.jp",
  ke:      "whois.kenic.or.ke",
  kg:      "whois.domain.kg",
  kh:      "whois.nic.kh",
  ki:      "whois.nic.ki",
  km:      "whois.nic.km",
  kn:      "whois.nic.kn",
  kp:      "whois.nic.kp",
  kr:      "whois.kr",
  kw:      "whois.kics.gov.kw",
  ky:      "whois.ky",
  kz:      "whois.nic.kz",
  la:      "whois.nic.la",
  lb:      "whois.lbdr.org.lb",
  lc:      "whois.nic.lc",
  li:      "whois.nic.li",
  lk:      "whois.nic.lk",
  lr:      "whois.psg.com",
  ls:      "whois.nic.ls",
  lt:      "whois.domreg.lt",
  lu:      "whois.dns.lu",
  lv:      "whois.nic.lv",
  ly:      "whois.nic.ly",
  ma:      "whois.iam.net.ma",
  mc:      "whois.ripe.net",
  md:      "whois.nic.md",
  me:      "whois.nic.me",
  mg:      "whois.nic.mg",
  mh:      "whois.nic.mh",
  mk:      "whois.ripe.net",
  ml:      "whois.dot.ml",
  mm:      "whois.nic.mm",
  mn:      "whois.nic.mn",
  mo:      "whois.monic.mo",
  mp:      "whois.nic.mp",
  mq:      "whois.nic.fr",
  mr:      "whois.nic.mr",
  ms:      "whois.nic.ms",
  mt:      "whois.ripe.net",
  mu:      "whois.nic.mu",
  mv:      "whois.nic.mv",
  mw:      "whois.nic.mw",
  mx:      "whois.mx",
  my:      "whois.mynic.my",
  mz:      "whois.nic.mz",
  na:      "whois.na-nic.com.na",
  nc:      "whois.nc",
  ne:      "whois.nic.ne",
  nf:      "whois.nic.nf",
  ng:      "whois.nic.net.ng",
  ni:      "whois.nic.ni",
  nl:      "whois.domain-registry.nl",
  no:      "whois.norid.no",
  np:      "whois.nic.np",
  nr:      "whois.nic.nr",
  nu:      "whois.iis.nu",
  nz:      "whois.irs.net.nz",
  om:      "whois.registry.om",
  pa:      "whois.nic.pa",
  pe:      "kero.yachay.pe",
  pf:      "whois.registry.pf",
  pg:      "whois.nic.pg",
  ph:      "whois.dot.ph",
  pk:      "whois.pknic.net.pk",
  pl:      "whois.dns.pl",
  pm:      "whois.nic.fr",
  pn:      "whois.nic.pn",
  pr:      "whois.nic.pr",
  ps:      "whois.pnina.ps",
  pt:      "whois.dns.pt",
  pw:      "whois.nic.pw",
  py:      "whois.nic.py",
  qa:      "whois.registry.qa",
  re:      "whois.nic.fr",
  ro:      "whois.rotld.ro",
  rs:      "whois.rnids.rs",
  ru:      "whois.tcinet.ru",
  rw:      "whois.ricta.org.rw",
  sa:      "whois.nic.net.sa",
  sb:      "whois.nic.net.sb",
  sc:      "whois2.afilias-grs.net",
  sd:      "whois.sdnic.sd",
  se:      "whois.iis.se",
  sg:      "whois.sgnic.sg",
  sh:      "whois.nic.sh",
  si:      "whois.arnes.si",
  sj:      "whois.norid.no",
  sk:      "whois.sk-nic.sk",
  sl:      "whois.nic.sl",
  sm:      "whois.nic.sm",
  sn:      "whois.nic.sn",
  so:      "whois.nic.so",
  sr:      "whois.nic.sr",
  ss:      "whois.nic.ss",
  st:      "whois.nic.st",
  su:      "whois.tcinet.ru",
  sv:      "whois.nic.sv",
  sx:      "whois.sx",
  sy:      "whois.tld.sy",
  sz:      "whois.nicszregistry.net",
  tc:      "whois.meridiantld.net",
  td:      "whois.nic.td",
  tf:      "whois.nic.fr",
  tg:      "whois.nic.tg",
  th:      "whois.thnic.co.th",
  tj:      "whois.nic.tj",
  tk:      "whois.dot.tk",
  tl:      "whois.nic.tl",
  tm:      "whois.nic.tm",
  tn:      "whois.ati.tn",
  to:      "whois.tonic.to",
  tr:      "whois.nic.tr",
  tt:      "whois.nic.tt",
  tv:      "tvwhois.verisign-grs.com",
  tw:      "whois.twnic.net.tw",
  tz:      "whois.tznic.or.tz",
  ua:      "whois.ua",
  ug:      "whois.co.ug",
  uk:      "whois.nic.uk",
  us:      "whois.nic.us",
  uy:      "whois.nic.org.uy",
  uz:      "whois.cctld.uz",
  va:      "whois.ripe.net",
  vc:      "whois.nic.vc",
  ve:      "whois.nic.ve",
  vg:      "whois.nic.vg",
  vi:      "whois.nic.vi",
  vn:      "whois.vnnic.net.vn",
  vu:      "whois.vanuatuwhois.net",
  wf:      "whois.nic.fr",
  ws:      "whois.website.ws",
  ye:      "whois.y.net.ye",
  yt:      "whois.nic.fr",
  za:      "whois.registry.net.za",
  zm:      "whois.zicta.zm",
  zw:      "whois.potraz.zw",
};

// ── IP RIR routing ────────────────────────────────────────────────────────────
// Map IP range prefixes to Regional Internet Registries.
// In practice ARIN responds first and provides referrals, so we start there.
// For well-known blocks we route directly.
const RIR_SERVERS = {
  arin:    "whois.arin.net",
  ripe:    "whois.ripe.net",
  apnic:   "whois.apnic.net",
  lacnic:  "whois.lacnic.net",
  afrinic: "whois.afrinic.net",
};

// Rough prefix → RIR mapping for common blocks (best-effort; not exhaustive)
const IP_RIR_MAP = [
  // RIPE NCC  (Europe, Middle East, Central Asia)
  { prefix: "2." ,   rir: "ripe"    },
  { prefix: "5." ,   rir: "ripe"    },
  { prefix: "31.",   rir: "ripe"    },
  { prefix: "37.",   rir: "ripe"    },
  { prefix: "46.",   rir: "ripe"    },
  { prefix: "62.",   rir: "ripe"    },
  { prefix: "77.",   rir: "ripe"    },
  { prefix: "78.",   rir: "ripe"    },
  { prefix: "79.",   rir: "ripe"    },
  { prefix: "80.",   rir: "ripe"    },
  { prefix: "81.",   rir: "ripe"    },
  { prefix: "82.",   rir: "ripe"    },
  { prefix: "83.",   rir: "ripe"    },
  { prefix: "84.",   rir: "ripe"    },
  { prefix: "85.",   rir: "ripe"    },
  { prefix: "86.",   rir: "ripe"    },
  { prefix: "87.",   rir: "ripe"    },
  { prefix: "88.",   rir: "ripe"    },
  { prefix: "89.",   rir: "ripe"    },
  { prefix: "90.",   rir: "ripe"    },
  { prefix: "91.",   rir: "ripe"    },
  { prefix: "92.",   rir: "ripe"    },
  { prefix: "93.",   rir: "ripe"    },
  { prefix: "94.",   rir: "ripe"    },
  { prefix: "95.",   rir: "ripe"    },
  { prefix: "176.",  rir: "ripe"    },
  { prefix: "178.",  rir: "ripe"    },
  { prefix: "185.",  rir: "ripe"    },
  { prefix: "188.",  rir: "ripe"    },
  { prefix: "193.",  rir: "ripe"    },
  { prefix: "194.",  rir: "ripe"    },
  { prefix: "195.",  rir: "ripe"    },
  { prefix: "212.",  rir: "ripe"    },
  { prefix: "213.",  rir: "ripe"    },
  { prefix: "217.",  rir: "ripe"    },
  // APNIC (Asia-Pacific)
  { prefix: "1." ,   rir: "apnic"   },
  { prefix: "14.",   rir: "apnic"   },
  { prefix: "27.",   rir: "apnic"   },
  { prefix: "36.",   rir: "apnic"   },
  { prefix: "39.",   rir: "apnic"   },
  { prefix: "42.",   rir: "apnic"   },
  { prefix: "43.",   rir: "apnic"   },
  { prefix: "49.",   rir: "apnic"   },
  { prefix: "58.",   rir: "apnic"   },
  { prefix: "59.",   rir: "apnic"   },
  { prefix: "60.",   rir: "apnic"   },
  { prefix: "61.",   rir: "apnic"   },
  { prefix: "103.",  rir: "apnic"   },
  { prefix: "110.",  rir: "apnic"   },
  { prefix: "111.",  rir: "apnic"   },
  { prefix: "112.",  rir: "apnic"   },
  { prefix: "113.",  rir: "apnic"   },
  { prefix: "114.",  rir: "apnic"   },
  { prefix: "115.",  rir: "apnic"   },
  { prefix: "116.",  rir: "apnic"   },
  { prefix: "117.",  rir: "apnic"   },
  { prefix: "118.",  rir: "apnic"   },
  { prefix: "119.",  rir: "apnic"   },
  { prefix: "120.",  rir: "apnic"   },
  { prefix: "121.",  rir: "apnic"   },
  { prefix: "122.",  rir: "apnic"   },
  { prefix: "123.",  rir: "apnic"   },
  { prefix: "124.",  rir: "apnic"   },
  { prefix: "125.",  rir: "apnic"   },
  { prefix: "126.",  rir: "apnic"   },
  { prefix: "150.",  rir: "apnic"   },
  { prefix: "153.",  rir: "apnic"   },
  { prefix: "163.",  rir: "apnic"   },
  { prefix: "171.",  rir: "apnic"   },
  { prefix: "175.",  rir: "apnic"   },
  { prefix: "180.",  rir: "apnic"   },
  { prefix: "182.",  rir: "apnic"   },
  { prefix: "183.",  rir: "apnic"   },
  { prefix: "202.",  rir: "apnic"   },
  { prefix: "203.",  rir: "apnic"   },
  { prefix: "210.",  rir: "apnic"   },
  { prefix: "211.",  rir: "apnic"   },
  { prefix: "218.",  rir: "apnic"   },
  { prefix: "219.",  rir: "apnic"   },
  { prefix: "220.",  rir: "apnic"   },
  { prefix: "221.",  rir: "apnic"   },
  { prefix: "222.",  rir: "apnic"   },
  { prefix: "223.",  rir: "apnic"   },
  // LACNIC (Latin America / Caribbean)
  { prefix: "177.",  rir: "lacnic"  },
  { prefix: "179.",  rir: "lacnic"  },
  { prefix: "181.",  rir: "lacnic"  },
  { prefix: "186.",  rir: "lacnic"  },
  { prefix: "187.",  rir: "lacnic"  },
  { prefix: "189.",  rir: "lacnic"  },
  { prefix: "190.",  rir: "lacnic"  },
  { prefix: "191.",  rir: "lacnic"  },
  { prefix: "200.",  rir: "lacnic"  },
  { prefix: "201.",  rir: "lacnic"  },
  // AFRINIC (Africa)
  { prefix: "41.",   rir: "afrinic" },
  { prefix: "102.",  rir: "afrinic" },
  { prefix: "105.",  rir: "afrinic" },
  { prefix: "154.",  rir: "afrinic" },
  { prefix: "196.",  rir: "afrinic" },
  { prefix: "197.",  rir: "afrinic" },
  // ARIN (default — North America, catch-all)
];

// ── Guards ────────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`whois_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

function validatePort(port) {
  const p = port ?? WHOIS_PORT;
  if (!Number.isInteger(p) || p < 1 || p > 65535)
    throw new Error(`whois_client: 'port' must be an integer 1–65535 (got ${p}).`);
  return p;
}

// ── Core TCP query ────────────────────────────────────────────────────────────
/**
 * Send 'query\r\n' to server:port, collect response, return as string.
 * Response is capped at MAX_RESPONSE_BYTES.
 */
function tcpWhoisQuery(server, port, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let done = false;

    const sock = net.createConnection({ host: server, port, family: 0 });
    sock.setTimeout(timeoutMs);

    const finish = (err) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };

    sock.on("connect", () => {
      sock.write(query + "\r\n");
    });

    sock.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        // Cap: take only what fits
        const remaining = MAX_RESPONSE_BYTES - (totalBytes - chunk.length);
        if (remaining > 0) chunks.push(chunk.slice(0, remaining));
        finish(null);
      } else {
        chunks.push(chunk);
      }
    });

    sock.on("end",     () => finish(null));
    sock.on("close",   () => finish(null));

    sock.on("timeout", () => {
      finish(new Error(
        `whois_client: query to ${server}:${port} timed out after ${timeoutMs} ms.`
      ));
    });

    sock.on("error", (err) => {
      if (err.code === "ENOTFOUND")
        finish(new Error(`whois_client: host not found: '${server}'.`));
      else if (err.code === "ECONNREFUSED")
        finish(new Error(`whois_client: connection refused by ${server}:${port}.`));
      else
        finish(new Error(`whois_client: network error querying ${server}: ${err.message}`));
    });
  });
}

// ── Referral parser ───────────────────────────────────────────────────────────
/**
 * Look for WHOIS referral hints in the response text.
 * Handles patterns used by IANA, ARIN, RIPE, Verisign, etc.
 */
function extractReferral(text) {
  // IANA: "refer: whois.example.com"
  let m = text.match(/^refer:\s*(\S+)/mi);
  if (m) return m[1].trim().toLowerCase();

  // ARIN: "ReferralServer: whois://whois.ripe.net"
  m = text.match(/^ReferralServer:\s*(?:r?whois:\/\/)?([\w.-]+)/mi);
  if (m) return m[1].trim().toLowerCase();

  // Verisign/gTLD: "Registrar WHOIS Server: whois.example.com"
  m = text.match(/^Registrar WHOIS Server:\s*(\S+)/mi);
  if (m) return m[1].trim().toLowerCase();

  // RIPE forward: "whois:            whois.example.net"
  m = text.match(/^whois:\s+(whois\.\S+)/mi);
  if (m) return m[1].trim().toLowerCase();

  return null;
}

// ── Domain helpers ────────────────────────────────────────────────────────────
function extractTld(domain) {
  const parts = domain.toLowerCase().replace(/\.+$/, "").split(".");
  return parts[parts.length - 1];
}

function resolveDomainServer(domain) {
  const tld = extractTld(domain);
  return TLD_SERVERS[tld] || IANA_WHOIS;
}

// ── IP helpers ────────────────────────────────────────────────────────────────
function isIPv6(addr) {
  return addr.includes(":");
}

function resolveIpServer(ip) {
  if (isIPv6(ip)) {
    // Route IPv6 by common prefixes
    const upper = ip.toUpperCase();
    if (upper.startsWith("2A") || upper.startsWith("2001:0") ||
        upper.startsWith("2001:14") || upper.startsWith("2001:16") ||
        upper.startsWith("2001:67")) return RIR_SERVERS.ripe;
    if (upper.startsWith("2001:44") || upper.startsWith("2001:40") ||
        upper.startsWith("2400") || upper.startsWith("2404") ||
        upper.startsWith("2407") || upper.startsWith("2408") ||
        upper.startsWith("240B") || upper.startsWith("2409")) return RIR_SERVERS.apnic;
    return RIR_SERVERS.arin;
  }

  // IPv4 — match by dotted prefix
  const first = ip.split(".")[0] + ".";
  const second = ip.split(".").slice(0, 2).join(".") + ".";
  for (const { prefix, rir } of IP_RIR_MAP) {
    if (ip.startsWith(prefix) || first === prefix || second === prefix) {
      return RIR_SERVERS[rir];
    }
  }
  return RIR_SERVERS.arin; // Default: ARIN
}

// ── Validate IP format ────────────────────────────────────────────────────────
function validateIp(ip) {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.every(p => p >= 0 && p <= 255)) return "ipv4";
  }
  // IPv6 (simplified check)
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return "ipv6";
  return null;
}

// ── Validate ASN format ───────────────────────────────────────────────────────
function validateAsn(asn) {
  // Accept: 12345, AS12345, ASN12345 (case-insensitive)
  const m = String(asn).trim().match(/^(?:AS[N]?)?([0-9]+)$/i);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (num < 0 || num > 4294967295) return null;
  return num;
}

// ── Response parser ───────────────────────────────────────────────────────────
/**
 * Parse common WHOIS field:value pairs from the response text.
 * Returns a structured object with common fields extracted.
 */
function parseWhoisResponse(text, operation) {
  const lines  = text.split(/\r?\n/);
  const fields = {};
  const comments = [];

  // Patterns to extract
  const FIELD_MAP = {
    // Domain fields
    "Domain Name":            "domainName",
    "Registry Domain ID":     "registryDomainId",
    "Registrar":              "registrar",
    "Registrar WHOIS Server": "registrarWhoisServer",
    "Registrar URL":          "registrarUrl",
    "Updated Date":           "updatedDate",
    "Creation Date":          "creationDate",
    "Registry Expiry Date":   "expiryDate",
    "Registrar Registration Expiration Date": "expiryDate",
    "Expiry Date":            "expiryDate",
    "Expiration Date":        "expiryDate",
    "Registrar Abuse Contact Email": "abuseEmail",
    "Registrar Abuse Contact Phone": "abusePhone",
    "Domain Status":          "status",
    "Name Server":            "nameservers",
    "DNSSEC":                 "dnssec",
    // IP / network fields
    "NetRange":               "netRange",
    "CIDR":                   "cidr",
    "NetName":                "netName",
    "NetHandle":              "netHandle",
    "NetType":                "netType",
    "OriginAS":               "originAs",
    "Organization":           "organization",
    "OrgName":                "orgName",
    "OrgId":                  "orgId",
    "Address":                "address",
    "City":                   "city",
    "StateProv":              "stateProv",
    "PostalCode":             "postalCode",
    "Country":                "country",
    "inetnum":                "inetnum",
    "netname":                "netname",
    "descr":                  "description",
    "country":                "country",
    "org":                    "org",
    "mnt-by":                 "maintainedBy",
    // ASN fields
    "ASHandle":               "asHandle",
    "ASName":                 "asName",
    "ASNumber":               "asNumber",
    "aut-num":                "autNum",
    "as-name":                "asName",
    // Registrant
    "Registrant Name":        "registrantName",
    "Registrant Organization":"registrantOrg",
    "Registrant Email":       "registrantEmail",
    "Registrant Country":     "registrantCountry",
    // Admin / Tech
    "Admin Email":            "adminEmail",
    "Tech Email":             "techEmail",
    // RIPE / APNIC
    "last-modified":          "lastModified",
    "remarks":                "remarks",
    "tech-c":                 "techContact",
    "admin-c":                "adminContact",
    "status":                 "status",
    "source":                 "source",
    "refer":                  "referServer",
    // TLD
    "organisation":           "organisation",
    "nserver":                "nameservers",
    "ds-rdata":               "dsRdata",
    "whois":                  "whoisServer",
  };

  for (const line of lines) {
    if (line.startsWith("%") || line.startsWith("#")) {
      comments.push(line);
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const rawKey = line.slice(0, colonIdx).trim();
    const val    = line.slice(colonIdx + 1).trim();
    if (!val) continue;

    const mappedKey = FIELD_MAP[rawKey];
    if (mappedKey) {
      if (mappedKey === "nameservers" || mappedKey === "status" ||
          mappedKey === "remarks" || mappedKey === "dsRdata" ||
          mappedKey === "techContact" || mappedKey === "adminContact" ||
          mappedKey === "maintainedBy") {
        // Multi-value fields → array
        if (!fields[mappedKey]) fields[mappedKey] = [];
        fields[mappedKey].push(val);
      } else if (!fields[mappedKey]) {
        // First-occurrence wins for single-value fields
        fields[mappedKey] = val;
      }
    }
  }

  // Deduplicate multi-value arrays
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      fields[k] = [...new Set(v)];
    }
  }

  return { fields, comments };
}

// ── Multi-hop WHOIS query ─────────────────────────────────────────────────────
/**
 * Query WHOIS with optional referral following.
 * Returns { server, query, raw, referrals: [{server, raw}] }
 */
async function whoisLookup(server, port, query, timeoutMs, followReferrals = true) {
  const referrals = [];
  let currentServer = server;
  let finalRaw      = "";
  let depth         = 0;

  while (depth <= MAX_REFERRAL_DEPTH) {
    const raw = await tcpWhoisQuery(currentServer, port, query, timeoutMs);
    finalRaw  = raw;

    if (depth === 0 || !followReferrals) break;

    const ref = extractReferral(raw);
    if (!ref || ref === currentServer) break;

    referrals.push({ server: currentServer, snippet: raw.slice(0, 500) });
    currentServer = ref;
    depth++;
  }

  // First query + follow referrals
  if (followReferrals && depth === 0) {
    const ref = extractReferral(finalRaw);
    if (ref && ref !== server) {
      const refRaw = await tcpWhoisQuery(ref, port, query, timeoutMs).catch(() => null);
      if (refRaw) {
        referrals.push({ server, snippet: finalRaw.slice(0, 500) });
        return { server: ref, query, raw: refRaw, referrals };
      }
    }
  }

  return { server: currentServer, query, raw: finalRaw, referrals };
}

// ── Operations ────────────────────────────────────────────────────────────────

/** domain — Query a domain name */
async function opDomain(args) {
  const domain = (args.domain || "").trim().toLowerCase();
  if (!domain) throw new Error("whois_client: 'domain' is required for operation 'domain'.");
  guardNul(domain, "domain");
  if (!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(domain))
    throw new Error(`whois_client: invalid domain name '${domain}'.`);

  const server    = args.server || resolveDomainServer(domain);
  const port      = validatePort(args.port);
  const timeoutMs = clampTimeout(args.timeout);
  const follow    = args.follow_referrals !== false;

  guardNul(server, "server");

  const t0    = Date.now();
  const result = await whoisLookup(server, port, domain, timeoutMs, follow);
  const elapsed = Date.now() - t0;

  const { fields, comments } = parseWhoisResponse(result.raw, "domain");

  return {
    ok:           true,
    operation:    "domain",
    query:        domain,
    server:       result.server,
    elapsedMs:    elapsed,
    fields,
    raw:          result.raw,
    referrals:    result.referrals,
    truncated:    result.raw.length >= MAX_RESPONSE_BYTES,
  };
}

/** ip — Query an IP address */
async function opIp(args) {
  const ip = (args.ip || "").trim();
  if (!ip) throw new Error("whois_client: 'ip' is required for operation 'ip'.");
  guardNul(ip, "ip");

  const ipType = validateIp(ip);
  if (!ipType) throw new Error(`whois_client: invalid IP address '${ip}'.`);

  const server    = args.server || resolveIpServer(ip);
  const port      = validatePort(args.port);
  const timeoutMs = clampTimeout(args.timeout);
  const follow    = args.follow_referrals !== false;

  // ARIN uses a different query prefix for IPs
  const queryStr  = server.includes("arin.net") ? `n ${ip}` : ip;

  const t0     = Date.now();
  const result  = await whoisLookup(server, port, queryStr, timeoutMs, follow);
  const elapsed = Date.now() - t0;

  const { fields } = parseWhoisResponse(result.raw, "ip");

  return {
    ok:        true,
    operation: "ip",
    query:     ip,
    ipVersion: ipType === "ipv6" ? 6 : 4,
    server:    result.server,
    elapsedMs: elapsed,
    fields,
    raw:       result.raw,
    referrals: result.referrals,
    truncated: result.raw.length >= MAX_RESPONSE_BYTES,
  };
}

/** asn — Query an Autonomous System Number */
async function opAsn(args) {
  const asnInput = args.asn !== undefined ? String(args.asn) : "";
  if (!asnInput) throw new Error("whois_client: 'asn' is required for operation 'asn'.");
  guardNul(asnInput, "asn");

  const asnNum = validateAsn(asnInput);
  if (asnNum === null) throw new Error(`whois_client: invalid ASN '${asnInput}'. Use a number (12345) or AS-prefixed form (AS12345).`);

  const server    = args.server || RIR_SERVERS.arin;  // ARIN is authoritative for ASN queries; referrals follow
  const port      = validatePort(args.port);
  const timeoutMs = clampTimeout(args.timeout);
  const follow    = args.follow_referrals !== false;

  // ARIN ASN query prefix
  const queryStr = server.includes("arin.net") ? `a ${asnNum}` : `AS${asnNum}`;

  const t0     = Date.now();
  const result  = await whoisLookup(server, port, queryStr, timeoutMs, follow);
  const elapsed = Date.now() - t0;

  const { fields } = parseWhoisResponse(result.raw, "asn");

  return {
    ok:        true,
    operation: "asn",
    query:     `AS${asnNum}`,
    asnNumber: asnNum,
    server:    result.server,
    elapsedMs: elapsed,
    fields,
    raw:       result.raw,
    referrals: result.referrals,
    truncated: result.raw.length >= MAX_RESPONSE_BYTES,
  };
}

/** tld — Query a TLD at IANA */
async function opTld(args) {
  let tld = (args.tld || "").trim().toLowerCase().replace(/^\./, "");
  if (!tld) throw new Error("whois_client: 'tld' is required for operation 'tld'.");
  guardNul(tld, "tld");
  if (!/^[a-z0-9-]{1,63}$/.test(tld))
    throw new Error(`whois_client: invalid TLD '${tld}'.`);

  const server    = args.server || IANA_WHOIS;
  const port      = validatePort(args.port);
  const timeoutMs = clampTimeout(args.timeout);

  const t0     = Date.now();
  const raw    = await tcpWhoisQuery(server, port, tld, timeoutMs);
  const elapsed = Date.now() - t0;

  const { fields } = parseWhoisResponse(raw, "tld");
  const knownServer = TLD_SERVERS[tld];

  return {
    ok:          true,
    operation:   "tld",
    query:       tld,
    server,
    elapsedMs:   elapsed,
    fields,
    knownWhoisServer: knownServer || fields.whoisServer || null,
    raw,
    truncated:   raw.length >= MAX_RESPONSE_BYTES,
  };
}

/** raw — Raw query to an explicit server */
async function opRaw(args) {
  const query  = args.query;
  if (!query && query !== "") throw new Error("whois_client: 'query' is required for operation 'raw'.");
  const server = args.server;
  if (!server) throw new Error("whois_client: 'server' is required for operation 'raw'.");

  guardNul(String(query), "query");
  guardNul(server, "server");

  const port      = validatePort(args.port);
  const timeoutMs = clampTimeout(args.timeout);

  const t0     = Date.now();
  const raw    = await tcpWhoisQuery(server, port, String(query), timeoutMs);
  const elapsed = Date.now() - t0;

  const { fields } = parseWhoisResponse(raw, "raw");

  return {
    ok:        true,
    operation: "raw",
    query:     String(query),
    server,
    port,
    elapsedMs: elapsed,
    fields,
    raw,
    truncated: raw.length >= MAX_RESPONSE_BYTES,
  };
}

/** info — Return configuration and routing info (no I/O) */
function opInfo(args) {
  const timeoutMs  = clampTimeout(args.timeout);

  return {
    ok:          true,
    operation:   "info",
    protocol:    "WHOIS — RFC 3912, plain TCP port 43",
    defaultPort: WHOIS_PORT,
    timeoutMs,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxReferralDepth: MAX_REFERRAL_DEPTH,
    ianaWhois:   IANA_WHOIS,
    rirServers:  RIR_SERVERS,
    knownTldCount: Object.keys(TLD_SERVERS).length,
    operations:  ["domain", "ip", "asn", "tld", "raw", "info"],
    routing: {
      domain:  "Routes to TLD-specific WHOIS server; falls back to whois.iana.org",
      ip:      "Routes by IP block to ARIN/RIPE/APNIC/LACNIC/AFRINIC; follows ReferralServer",
      asn:     "Queries ARIN first (a <num>); follows ReferralServer for non-ARIN ASNs",
      tld:     "Always queries whois.iana.org",
      raw:     "Direct query to caller-specified server (no routing/referrals)",
    },
    notes: [
      "WHOIS has no built-in authentication or encryption.",
      "Rate limiting by WHOIS servers is common; avoid rapid repeated queries.",
      "Registrar privacy/redaction may hide personal contact fields per GDPR.",
      "follow_referrals: true (default) causes up to one additional hop to the registrar's WHOIS server.",
    ],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function whoisClient(args) {
  const op = args.operation;
  if (!op) throw new Error("whois_client: 'operation' is required.");

  switch (op) {
    case "domain":  return opDomain(args);
    case "ip":      return opIp(args);
    case "asn":     return opAsn(args);
    case "tld":     return opTld(args);
    case "raw":     return opRaw(args);
    case "info":    return opInfo(args);
    default:
      throw new Error(
        `whois_client: unknown operation '${op}'. ` +
        `Valid: domain, ip, asn, tld, raw, info.`
      );
  }
}

module.exports = {
  whoisClient,
  // Exported for testing
  extractReferral,
  parseWhoisResponse,
  resolveDomainServer,
  resolveIpServer,
  validateIp,
  validateAsn,
  TLD_SERVERS,
  RIR_SERVERS,
};
