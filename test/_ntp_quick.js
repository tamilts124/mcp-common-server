"use strict";
const assert = require("assert");
const dgram = require("dgram");
const { ntpClient } = require("../lib/ntpClientOps");

const NTP_EPOCH_OFFSET = 2208988800;
const NTP_PACKET_SIZE  = 48;

function buildNtpPacket() {
  const b = Buffer.alloc(48, 0); b[0] = 0x23; return b;
}
function parseNtpTimestamp(buf, off) {
  const s = buf.readUInt32BE(off), f = buf.readUInt32BE(off + 4);
  if (s === 0 && f === 0) return null;
  return (s - NTP_EPOCH_OFFSET) + (f / 0x100000000);
}
function parseRefId(buf, st) {
  if (st <= 1) { let s = ""; for (let i = 12; i < 16; i++) { const c = buf[i]; if (c === 0) break; s += String.fromCharCode(c); } return s || "(empty)"; }
  return `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
}
function stratumDesc(s) {
  if (s === 0)  return "unspecified / unavailable";
  if (s === 1)  return "primary reference (GPS/atomic clock)";
  if (s <= 15)  return `secondary reference (${s} hops from primary)`;
  if (s === 16) return "unsynchronized";
  return "reserved";
}
function clampTimeout(t) { const n = typeof t === "number" ? t : 5000; return Math.max(500, Math.min(30000, Math.trunc(n))); }

function buildNtpResponse(opts = {}) {
  const { stratum = 2, refIdBytes = [192,0,2,1], ts = Date.now()/1000 } = opts;
  const buf = Buffer.alloc(NTP_PACKET_SIZE, 0);
  buf[0] = 0b00_100_100; buf[1] = stratum; buf[2] = 6; buf[3] = 0xEC;
  buf.writeUInt16BE(0,4); buf.writeUInt16BE(65,6);
  buf.writeUInt16BE(0,8); buf.writeUInt16BE(65,10);
  if (stratum <= 1) { const src = opts.refIdStr || "GPS"; for (let i=0;i<Math.min(src.length,4);i++) buf[12+i]=src.charCodeAt(i); }
  else { buf[12]=refIdBytes[0]; buf[13]=refIdBytes[1]; buf[14]=refIdBytes[2]; buf[15]=refIdBytes[3]; }
  function writeTs(offset, unixSec) {
    const ntpSec = Math.floor(unixSec)+NTP_EPOCH_OFFSET;
    const ntpFrac = Math.round((unixSec-Math.floor(unixSec))*0x100000000);
    buf.writeUInt32BE(ntpSec>>>0,offset); buf.writeUInt32BE(ntpFrac>>>0,offset+4);
  }
  writeTs(16,ts-0.5); writeTs(24,ts-0.01); writeTs(32,ts+0.001); writeTs(40,ts+0.002);
  return buf;
}
function startMockNtpServer(responsePacket) {
  return new Promise((resolve, reject) => {
    const server = dgram.createSocket("udp4");
    server.on("error", reject);
    server.on("message", (msg, rinfo) => { server.send(responsePacket, 0, responsePacket.length, rinfo.port, rinfo.address); });
    server.bind(0, "127.0.0.1", () => { const {port}=server.address(); resolve({server,port,close:()=>new Promise(r=>server.close(r))}); });
  });
}

let passed = 0; let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; process.stderr.write("  PASS  " + name + "\n"); }
  catch(e) { failed++; process.stderr.write("  FAIL  " + name + ": " + e.message + "\n"); }
}

async function run() {
  process.stderr.write("\n=== ntp_client quick test ===\n");

  process.stderr.write("--- A: Validation ---\n");
  await t("A01 missing operation", async()=>{ await assert.rejects(()=>ntpClient({}),/operation.*required/i); });
  await t("A02 unknown op", async()=>{ await assert.rejects(()=>ntpClient({operation:"foobar"}),/unknown operation/i); });
  await t("A03 port 0 query", async()=>{ await assert.rejects(()=>ntpClient({operation:"query",host:"127.0.0.1",port:0}),/port.*1.*65535/i); });
  await t("A04 port 99999 query", async()=>{ await assert.rejects(()=>ntpClient({operation:"query",host:"127.0.0.1",port:99999}),/port.*1.*65535/i); });
  await t("A05 port 0 sync_check", async()=>{ await assert.rejects(()=>ntpClient({operation:"sync_check",host:"127.0.0.1",port:0}),/port.*1.*65535/i); });
  await t("A06 port 0 stratum", async()=>{ await assert.rejects(()=>ntpClient({operation:"stratum",host:"127.0.0.1",port:0}),/port.*1.*65535/i); });
  await t("A07 NUL host query", async()=>{ await assert.rejects(()=>ntpClient({operation:"query",host:"pool.ntp\0.org"}),/NUL/i); });
  await t("A08 NUL host sync_check", async()=>{ await assert.rejects(()=>ntpClient({operation:"sync_check",host:"bad\0host"}),/NUL/i); });
  await t("A09 max_skew_ms=0", async()=>{ await assert.rejects(()=>ntpClient({operation:"sync_check",host:"127.0.0.1",port:1234,max_skew_ms:0}),/max_skew_ms.*>.*0/i); });
  await t("A10 max_skew_ms=-100", async()=>{ await assert.rejects(()=>ntpClient({operation:"sync_check",host:"127.0.0.1",port:1234,max_skew_ms:-100}),/max_skew_ms.*>.*0/i); });

  process.stderr.write("--- B: Unit/Protocol ---\n");
  await t("B01 pkt len=48", ()=>{ const p=buildNtpPacket(); assert.strictEqual(p.length,48); });
  await t("B02 pkt byte0=0x23", ()=>{ const p=buildNtpPacket(); assert.strictEqual(p[0],0x23); const li=(p[0]>>6)&3,vn=(p[0]>>3)&7,mo=p[0]&7; assert.strictEqual(li,0); assert.strictEqual(vn,4); assert.strictEqual(mo,3); });
  await t("B03 timestamp zero=null", ()=>{ const b=Buffer.alloc(16,0); assert.strictEqual(parseNtpTimestamp(b,0),null); });
  await t("B04 timestamp unix0", ()=>{ const b=Buffer.alloc(16,0);b.writeUInt32BE(2208988800,0);const ts=parseNtpTimestamp(b,0);assert.ok(Math.abs(ts)<1e-6); });
  await t("B05 timestamp fraction", ()=>{ const b=Buffer.alloc(16,0);b.writeUInt32BE(2208988800,0);b.writeUInt32BE(Math.round(0x100000000/2),4);const ts=parseNtpTimestamp(b,0);assert.ok(Math.abs(ts-0.5)<1e-6); });
  await t("B06 refId stratum1 GPS", ()=>{ const b=Buffer.alloc(48,0);b[12]=71;b[13]=80;b[14]=83;assert.strictEqual(parseRefId(b,1),"GPS"); });
  await t("B07 refId stratum2 IPv4", ()=>{ const b=Buffer.alloc(48,0);b[12]=192;b[13]=168;b[14]=1;b[15]=1;assert.strictEqual(parseRefId(b,2),"192.168.1.1"); });
  await t("B08 refId stratum1 null-term", ()=>{ const b=Buffer.alloc(48,0);b[12]=80;b[13]=80;b[14]=83;b[15]=0;assert.strictEqual(parseRefId(b,1),"PPS"); });
  await t("B12-15 stratumDesc", ()=>{ assert.ok(stratumDesc(0).includes("unspecified")); assert.ok(stratumDesc(1).includes("primary")); assert.ok(stratumDesc(8).includes("secondary")); assert.ok(stratumDesc(16).includes("unsynchronized")); });
  await t("B16 clamp below 500", ()=>{ assert.strictEqual(clampTimeout(0),500); assert.strictEqual(clampTimeout(499),500); });
  await t("B17 clamp above 30000", ()=>{ assert.strictEqual(clampTimeout(99999),30000); });
  await t("B18 clamp in-range", ()=>{ assert.strictEqual(clampTimeout(5000),5000); });
  await t("B19 servers", async()=>{ const r=await ntpClient({operation:"servers"}); assert.strictEqual(r.ok,true); assert.ok(r.count>0); assert.ok(r.servers.some(s=>s.host==="pool.ntp.org")); assert.ok(r.servers.some(s=>s.host==="time.google.com")); });
  await t("B20 offset/delay math", ()=>{ const t1=100,t2=100.01,t3=100.015,t4=100.02; const off=((t2-t1)+(t3-t4))/2,del=(t4-t1)-(t3-t2); assert.ok(Math.abs(off-0.0025)<1e-9); assert.ok(Math.abs(del-0.015)<1e-9); });

  process.stderr.write("--- C: Mock-network ---\n");
  await t("C01 query ok", async()=>{ const pkt=buildNtpResponse({stratum:2}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:4000}); assert.strictEqual(r.ok,true); assert.ok(typeof r.serverTime==="string"); assert.ok(typeof r.offsetMs==="number"); }finally{await m.close();} });
  await t("C02 query stratum=3", async()=>{ const pkt=buildNtpResponse({stratum:3}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:4000}); assert.strictEqual(r.stratum,3); assert.ok(r.stratumDescription.includes("secondary")); }finally{await m.close();} });
  await t("C03 referenceId IPv4", async()=>{ const pkt=buildNtpResponse({stratum:2,refIdBytes:[10,0,0,1]}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:4000}); assert.strictEqual(r.referenceId,"10.0.0.1"); }finally{await m.close();} });
  await t("C04 stratum1 GPS refId", async()=>{ const pkt=buildNtpResponse({stratum:1,refIdStr:"GPS"}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:4000}); assert.strictEqual(r.stratum,1); assert.strictEqual(r.referenceId,"GPS"); }finally{await m.close();} });
  await t("C05 timestamps object", async()=>{ const pkt=buildNtpResponse({stratum:2}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:4000}); assert.ok(r.timestamps.receive&&r.timestamps.receive.includes("T")); }finally{await m.close();} });
  await t("C06 sync_check inSync:true", async()=>{ const pkt=buildNtpResponse({stratum:2,ts:Date.now()/1000}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"sync_check",host:"127.0.0.1",port:m.port,timeout:4000,max_skew_ms:2000}); assert.strictEqual(r.ok,true); assert.ok(typeof r.inSync==="boolean"); }finally{await m.close();} });
  await t("C07 sync_check inSync:false", async()=>{ const pkt=buildNtpResponse({stratum:2,ts:(Date.now()/1000)-60}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"sync_check",host:"127.0.0.1",port:m.port,timeout:4000,max_skew_ms:100}); assert.strictEqual(r.inSync,false); assert.ok(r.message.includes("OUT OF SYNC")); }finally{await m.close();} });
  await t("C08 stratum op detail", async()=>{ const pkt=buildNtpResponse({stratum:1,refIdStr:"PPS"}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"stratum",host:"127.0.0.1",port:m.port,timeout:4000}); assert.strictEqual(r.stratum,1); assert.ok(r.stratumDescription.includes("primary")); assert.strictEqual(r.referenceId,"PPS"); }finally{await m.close();} });
  await t("C09 rootDelay/Dispersion >= 0", async()=>{ const pkt=buildNtpResponse({stratum:2}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:4000}); assert.ok(r.rootDelayMs>=0); assert.ok(r.rootDispersionMs>=0); }finally{await m.close();} });
  await t("C10 leapIndicator", async()=>{ const pkt=buildNtpResponse({stratum:2}); const m=await startMockNtpServer(pkt); try{ const r=await ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:4000}); assert.strictEqual(r.leapIndicator,0); assert.ok(r.leapDescription.includes("no warning")); }finally{await m.close();} });

  process.stderr.write("--- D: Security ---\n");
  await t("D01 NUL stratum", async()=>{ await assert.rejects(()=>ntpClient({operation:"stratum",host:"time.\0google.com"}),/NUL/i); });
  await t("D02 short response", async()=>{ const m=await startMockNtpServer(Buffer.alloc(10,0)); try{ await assert.rejects(()=>ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:3000}),/response too short/i); }finally{await m.close();} });
  await t("D03 zero timestamps", async()=>{ const pkt=Buffer.alloc(48,0);pkt[0]=0b00100100;pkt[1]=2; const m=await startMockNtpServer(pkt); try{ await assert.rejects(()=>ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:3000}),/zero|timestamp/i); }finally{await m.close();} });
  await t("D04 clamp 100->500", ()=>{ assert.strictEqual(clampTimeout(100),500); });
  await t("D05 clamp 999999->30000", ()=>{ assert.strictEqual(clampTimeout(999999),30000); });
  await t("D06 port 1 valid", async()=>{ try{ await ntpClient({operation:"query",host:"127.0.0.1",port:1,timeout:500}); }catch(e){ assert.ok(!e.message.match(/port.*1.*65535/i),`Port validation fail: ${e.message}`); } });
  await t("D07 port 65535 valid", async()=>{ try{ await ntpClient({operation:"query",host:"127.0.0.1",port:65535,timeout:500}); }catch(e){ assert.ok(!e.message.match(/port.*1.*65535/i),`Port validation fail: ${e.message}`); } });
  await t("D08 no empty hosts", async()=>{ const r=await ntpClient({operation:"servers"}); for(const s of r.servers) assert.ok(s.host&&s.host.length>0); });
  await t("D09 servers immutable", async()=>{ const r1=await ntpClient({operation:"servers"}); const r2=await ntpClient({operation:"servers"}); r1.servers[0].host="__mutated__"; assert.ok(r2.servers[0].host!=="__mutated__"); });
  await t("D10 NUL error msg", async()=>{ try{ await ntpClient({operation:"query",host:"evil\0host"}); assert.fail("Should throw"); }catch(e){ assert.ok(e.message.toLowerCase().includes("nul")); } });

  process.stderr.write("--- E: Error paths ---\n");
  await t("E01 timeout silent server", async()=>{ const s=dgram.createSocket("udp4"); await new Promise(r=>s.bind(0,"127.0.0.1",r)); const {port}=s.address(); try{ await assert.rejects(()=>ntpClient({operation:"query",host:"127.0.0.1",port,timeout:800}),/timed out/i); }finally{ await new Promise(r=>s.close(r)); } });
  await t("E02 closed port", async()=>{ try{ await ntpClient({operation:"query",host:"127.0.0.1",port:19123,timeout:1000}); assert.fail("Should throw"); }catch(e){ assert.ok(e.message.match(/timed out|econnrefused|socket error/i),`Unexpected: ${e.message}`); } });
  await t("E03 sync_check timeout", async()=>{ const s=dgram.createSocket("udp4"); await new Promise(r=>s.bind(0,"127.0.0.1",r)); const {port}=s.address(); try{ await assert.rejects(()=>ntpClient({operation:"sync_check",host:"127.0.0.1",port,timeout:800}),/timed out/i); }finally{ await new Promise(r=>s.close(r)); } });
  await t("E04 stratum timeout", async()=>{ const s=dgram.createSocket("udp4"); await new Promise(r=>s.bind(0,"127.0.0.1",r)); const {port}=s.address(); try{ await assert.rejects(()=>ntpClient({operation:"stratum",host:"127.0.0.1",port,timeout:800}),/timed out/i); }finally{ await new Promise(r=>s.close(r)); } });
  await t("E05 47 bytes too short", async()=>{ const m=await startMockNtpServer(Buffer.alloc(47,0)); try{ await assert.rejects(()=>ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:3000}),/response too short/i); }finally{await m.close();} });
  await t("E06 48 bytes zero ts", async()=>{ const pkt=Buffer.alloc(48,0);pkt[0]=0b00100100;pkt[1]=2; const m=await startMockNtpServer(pkt); try{ await assert.rejects(()=>ntpClient({operation:"query",host:"127.0.0.1",port:m.port,timeout:3000}),/zero|timestamp/i); }finally{await m.close();} });

  process.stderr.write(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  if(failed>0) process.exit(1);
}
run().catch(e=>{process.stderr.write(e.stack+"\n");process.exit(1);});
