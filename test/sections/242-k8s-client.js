"use strict";
/**
 * Section 242 — k8s_client offline tests
 * Tests the k8sClient function in isolation (no live Kubernetes cluster needed).
 * Five rigor levels:
 *   A: Validation (10) — invalid/missing args
 *   B: Unit (20)       — pure helper functions (parseKubeconfig, resolveKind, ageString, resourcePath etc.)
 *   C: Mock network (10) — happy-path ops with mocked https
 *   D: Security (10)   — NUL bytes, path traversal, credential leak checks
 *   E: Error paths (6) — missing kubeconfig, API errors, timeouts
 * Total: 56 tests
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// We import the named exports for unit-testing pure helpers
const {
  k8sClient,
  loadKubeconfig,
  parseKubeconfig,
  resolveKind,
  ageString,
} = require('../../lib/k8sClientOps');

// ─── test runner ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const TESTS = [];

function test(name, fn) {
  TESTS.push({ name, fn });
}

async function runAll() {
  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Section 242 k8s_client: ${passed}/${passed+failed} passed`);
  if (failed > 0) process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal valid kubeconfig YAML string */
function makeKubeconfig({ contextName = 'test-ctx', clusterName = 'test-cluster',
                           userName = 'test-user', server = 'https://localhost:6443',
                           token = 'test-token-abc', caDat = null, insecure = false } = {}) {
  const caLine = caDat
    ? `    certificate-authority-data: ${Buffer.from(caDat).toString('base64')}`
    : (insecure ? '    insecure-skip-tls-verify: true' : '');
  return `apiVersion: v1
kind: Config
current-context: ${contextName}
contexts:
- name: ${contextName}
  context:
    cluster: ${clusterName}
    user: ${userName}
    namespace: mynamespace
clusters:
- name: ${clusterName}
  cluster:
    server: ${server}
${caLine}
users:
- name: ${userName}
  user:
    token: ${token}
`;
}

/** Write a temp kubeconfig file and return its path */
function writeTempKubeconfig(opts) {
  const p = path.join(os.tmpdir(), `test-kube-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, makeKubeconfig(opts));
  return p;
}

// Mock https to avoid real network calls
const https  = require('https');
const http   = require('http');
const EventEmitter = require('events');

/**
 * Monkey-patch https.request to return a canned response.
 * Returns an undo function.
 */
function mockHttps({ status = 200, body = '{}', errorMsg = null }) {
  const origRequest = https.request;
  https.request = (options, cb) => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.headers    = { 'content-type': 'application/json' };
    const req = new EventEmitter();
    req.end  = () => {
      if (errorMsg) {
        setTimeout(() => req.emit('error', new Error(errorMsg)), 5);
        return;
      }
      setTimeout(() => {
        if (cb) cb(res);
        setTimeout(() => {
          res.emit('data', Buffer.from(body));
          res.emit('end');
        }, 5);
      }, 5);
    };
    req.write = () => {};
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = origRequest; };
}

// ═══════════════════════════════════════════════════════════
// A — Validation (10)
// ═══════════════════════════════════════════════════════════

test('A01: missing operation throws', async () => {
  await assert.rejects(
    () => k8sClient({ kubeconfig: '/nonexistent' }),
    /operation.*required/i,
  );
});

test('A02: unknown operation throws', async () => {
  await assert.rejects(
    () => k8sClient({ operation: 'frobnicate', kubeconfig: '/nonexistent' }),
    /unknown operation/i,
  );
});

test('A03: NUL byte in kubeconfig path', async () => {
  await assert.rejects(
    () => k8sClient({ operation: 'version', kubeconfig: '/tmp/foo\0bar' }),
    /NUL/i,
  );
});

test('A04: NUL byte in namespace', async () => {
  await assert.rejects(
    () => k8sClient({ operation: 'pods', namespace: 'default\0evil', kubeconfig: '/nonexistent' }),
    /NUL/i,
  );
});

test('A05: logs operation missing pod', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'logs', kubeconfig: kc }),
      /pod.*required/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('A06: get operation missing kind', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'get', kubeconfig: kc, name: 'mypod' }),
      /kind.*required/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('A07: get operation missing name', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'get', kubeconfig: kc, kind: 'pod' }),
      /name.*required/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('A08: list operation missing kind', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'list', kubeconfig: kc }),
      /kind.*required/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('A09: delete operation missing kind', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'delete', kubeconfig: kc, name: 'foo' }),
      /kind.*required/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('A10: apply operation missing manifest', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'apply', kubeconfig: kc }),
      /manifest.*required/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

// ═══════════════════════════════════════════════════════════
// B — Unit tests for pure helpers (20)
// ═══════════════════════════════════════════════════════════

test('B01: parseKubeconfig parses server correctly', () => {
  const kc = makeKubeconfig({ server: 'https://k8s.example.com:6443', token: 'tok123' });
  const cfg = parseKubeconfig(kc, 'test.yaml');
  assert.strictEqual(cfg.server, 'https://k8s.example.com:6443');
  assert.strictEqual(cfg.token, 'tok123');
});

test('B02: parseKubeconfig parses namespace from context', () => {
  const kc = makeKubeconfig({ contextName: 'prod' });
  const cfg = parseKubeconfig(kc, 'test.yaml');
  assert.strictEqual(cfg.namespace, 'mynamespace');
  assert.strictEqual(cfg.currentContext, 'prod');
});

test('B03: parseKubeconfig throws on missing current-context', () => {
  const yaml = `apiVersion: v1\ncurrent-context: nonexistent\ncontexts: []\nclusters: []\nusers: []\n`;
  assert.throws(() => parseKubeconfig(yaml, 'test.yaml'), /no valid context/i);
});

test('B04: parseKubeconfig throws on missing cluster', () => {
  const yaml = `apiVersion: v1
current-context: ctx1
contexts:
- name: ctx1
  context:
    cluster: missing-cluster
    user: u1
clusters: []
users:
- name: u1
  user:
    token: tok
`;
  assert.throws(() => parseKubeconfig(yaml, 'test.yaml'), /cluster.*not found/i);
});

test('B05: parseKubeconfig handles insecure-skip-tls-verify', () => {
  const kc = makeKubeconfig({ insecure: true });
  const cfg = parseKubeconfig(kc, 'test.yaml');
  assert.strictEqual(cfg.insecure, true);
});

test('B06: parseKubeconfig handles certificate-authority-data (base64)', () => {
  const fakeCert = 'FAKECERTDATA';
  const yaml = `apiVersion: v1
current-context: ctx
contexts:
- name: ctx
  context:
    cluster: cl
    user: u
clusters:
- name: cl
  cluster:
    server: https://localhost:6443
    certificate-authority-data: ${Buffer.from(fakeCert).toString('base64')}
users:
- name: u
  user:
    token: tok
`;
  const cfg = parseKubeconfig(yaml, 'test.yaml');
  assert.ok(Buffer.isBuffer(cfg.ca));
  assert.strictEqual(cfg.ca.toString(), fakeCert);
});

test('B07: parseKubeconfig handles client-certificate-data + client-key-data', () => {
  const yaml = `apiVersion: v1
current-context: ctx
contexts:
- name: ctx
  context:
    cluster: cl
    user: u
clusters:
- name: cl
  cluster:
    server: https://localhost:6443
users:
- name: u
  user:
    client-certificate-data: ${Buffer.from('cert-pem').toString('base64')}
    client-key-data: ${Buffer.from('key-pem').toString('base64')}
`;
  const cfg = parseKubeconfig(yaml, 'test.yaml');
  assert.ok(Buffer.isBuffer(cfg.clientCert));
  assert.strictEqual(cfg.clientCert.toString(), 'cert-pem');
  assert.ok(Buffer.isBuffer(cfg.clientKey));
  assert.strictEqual(cfg.clientKey.toString(), 'key-pem');
});

test('B08: parseKubeconfig throws on exec-based auth', () => {
  const yaml = `apiVersion: v1
current-context: ctx
contexts:
- name: ctx
  context:
    cluster: cl
    user: u
clusters:
- name: cl
  cluster:
    server: https://localhost
users:
- name: u
  user:
    exec:
      command: aws
`;
  assert.throws(() => parseKubeconfig(yaml, 'test.yaml'), /exec-based auth/i);
});

test('B09: resolveKind handles well-known core kinds', () => {
  const pod = resolveKind('pod');
  assert.strictEqual(pod.group, '');
  assert.strictEqual(pod.plural, 'pods');

  const pods = resolveKind('pods');
  assert.deepStrictEqual(pods, pod);
});

test('B10: resolveKind handles apps group kinds', () => {
  const dep = resolveKind('deployment');
  assert.strictEqual(dep.group, 'apps');
  assert.strictEqual(dep.plural, 'deployments');

  const ds = resolveKind('ds');
  assert.strictEqual(ds.plural, 'daemonsets');
});

test('B11: resolveKind handles batch kinds', () => {
  const job = resolveKind('job');
  assert.strictEqual(job.group, 'batch');

  const cj = resolveKind('cronjob');
  assert.strictEqual(cj.plural, 'cronjobs');
});

test('B12: resolveKind handles networking kinds', () => {
  const ing = resolveKind('ingress');
  assert.strictEqual(ing.group, 'networking.k8s.io');

  const ingAlias = resolveKind('ing');
  assert.strictEqual(ingAlias.plural, 'ingresses');
});

test('B13: resolveKind handles RBAC kinds', () => {
  const crb = resolveKind('clusterrolebinding');
  assert.strictEqual(crb.group, 'rbac.authorization.k8s.io');
});

test('B14: resolveKind returns null for unknown kind', () => {
  assert.strictEqual(resolveKind('nonexistentkind'), null);
  assert.strictEqual(resolveKind(''), null);
  assert.strictEqual(resolveKind(null), null);
});

test('B15: resolveKind is case-insensitive', () => {
  assert.ok(resolveKind('Pod'));
  assert.ok(resolveKind('DEPLOYMENT'));
  assert.ok(resolveKind('ConfigMap'));
});

test('B16: ageString returns seconds for <60s', () => {
  const now = new Date().toISOString();
  const age = ageString(now);
  // Within 1s of start
  assert.match(age, /^\d+s$/);
});

test('B17: ageString returns minutes for 1-hour-old ts', () => {
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const age = ageString(past);
  assert.match(age, /^\d+m$/);
});

test('B18: ageString returns hours for 2-hour-old ts', () => {
  const past = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const age = ageString(past);
  assert.match(age, /^\d+h$/);
});

test('B19: ageString returns days for 3-day-old ts', () => {
  const past = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
  const age = ageString(past);
  assert.match(age, /^\d+d$/);
});

test('B20: ageString returns null for null input', () => {
  assert.strictEqual(ageString(null), null);
  assert.strictEqual(ageString(undefined), null);
});

// ═══════════════════════════════════════════════════════════
// C — Mock network happy-path ops (10)
// ═══════════════════════════════════════════════════════════

test('C01: version operation returns cluster version', async () => {
  const kc = writeTempKubeconfig();
  try {
    const versionBody = JSON.stringify({
      gitVersion: 'v1.28.0', platform: 'linux/amd64', major: '1', minor: '28',
    });
    const restore = mockHttps({ status: 200, body: versionBody });
    const res = await k8sClient({ operation: 'version', kubeconfig: kc });
    restore();
    assert.strictEqual(res.gitVersion, 'v1.28.0');
    assert.strictEqual(res.platform, 'linux/amd64');
    assert.ok(res.context);
    assert.ok(res.server);
  } finally { fs.unlinkSync(kc); }
});

test('C02: namespaces operation returns list', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({
      items: [
        { metadata: { name: 'default', creationTimestamp: new Date().toISOString() }, status: { phase: 'Active' } },
        { metadata: { name: 'kube-system', creationTimestamp: new Date().toISOString() }, status: { phase: 'Active' } },
      ]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'namespaces', kubeconfig: kc });
    restore();
    assert.strictEqual(res.count, 2);
    assert.ok(Array.isArray(res.namespaces));
    assert.strictEqual(res.namespaces[0].name, 'default');
  } finally { fs.unlinkSync(kc); }
});

test('C03: pods operation returns summarised pods', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({
      items: [{
        metadata: { name: 'nginx-abc', namespace: 'default', creationTimestamp: new Date().toISOString(), labels: { app: 'nginx' } },
        spec: { containers: [{ name: 'nginx', image: 'nginx:1.25' }], nodeName: 'node1' },
        status: { phase: 'Running', podIP: '10.0.0.1', hostIP: '192.168.1.1',
          containerStatuses: [{ ready: true, restartCount: 0 }] },
      }]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'pods', namespace: 'default', kubeconfig: kc });
    restore();
    assert.strictEqual(res.count, 1);
    const pod = res.pods[0];
    assert.strictEqual(pod.name, 'nginx-abc');
    assert.strictEqual(pod.phase, 'Running');
    assert.strictEqual(pod.ready, '1/1');
    assert.strictEqual(pod.restarts, 0);
    assert.strictEqual(pod.node, 'node1');
  } finally { fs.unlinkSync(kc); }
});

test('C04: deployments operation returns summarised deployments', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({
      items: [{
        metadata: { name: 'web', namespace: 'default', creationTimestamp: new Date().toISOString(), labels: {} },
        spec: { replicas: 3, selector: { matchLabels: { app: 'web' } }, strategy: { type: 'RollingUpdate' },
          template: { spec: { containers: [{ image: 'web:v1.0' }] } } },
        status: { readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3, unavailableReplicas: 0 },
      }]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'deployments', namespace: 'default', kubeconfig: kc });
    restore();
    assert.strictEqual(res.count, 1);
    const dep = res.deployments[0];
    assert.strictEqual(dep.name, 'web');
    assert.strictEqual(dep.desired, 3);
    assert.strictEqual(dep.ready, 3);
    assert.strictEqual(dep.strategy, 'RollingUpdate');
  } finally { fs.unlinkSync(kc); }
});

test('C05: services operation returns summarised services', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({
      items: [{
        metadata: { name: 'web-svc', namespace: 'default', creationTimestamp: new Date().toISOString(), labels: {} },
        spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', ports: [{ protocol: 'TCP', port: 80 }], selector: { app: 'web' } },
        status: {},
      }]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'services', namespace: 'default', kubeconfig: kc });
    restore();
    assert.strictEqual(res.count, 1);
    assert.strictEqual(res.services[0].type, 'ClusterIP');
    assert.strictEqual(res.services[0].clusterIP, '10.96.0.1');
  } finally { fs.unlinkSync(kc); }
});

test('C06: nodes operation returns summarised nodes', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({
      items: [{
        metadata: { name: 'node1', creationTimestamp: new Date().toISOString(),
          labels: { 'node-role.kubernetes.io/control-plane': '' } },
        spec: { taints: [] },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          nodeInfo: { kubeletVersion: 'v1.28.0', osImage: 'Ubuntu 22.04', architecture: 'amd64', containerRuntimeVersion: 'containerd://1.6' },
          addresses: [{ type: 'InternalIP', address: '192.168.1.1' }],
          capacity: { cpu: '4', memory: '16Gi', pods: '110' },
          allocatable: { cpu: '3900m', memory: '15Gi' },
        },
      }]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'nodes', kubeconfig: kc });
    restore();
    assert.strictEqual(res.count, 1);
    const node = res.nodes[0];
    assert.strictEqual(node.status, 'Ready');
    assert.strictEqual(node.roles, 'control-plane');
    assert.strictEqual(node.cpu, '4');
  } finally { fs.unlinkSync(kc); }
});

test('C07: events operation returns sorted events with warning count', async () => {
  const kc = writeTempKubeconfig();
  try {
    const now = new Date().toISOString();
    const body = JSON.stringify({
      items: [
        { metadata: { namespace: 'default' }, type: 'Warning', reason: 'BackOff', message: 'restarting', count: 5, lastTimestamp: now },
        { metadata: { namespace: 'default' }, type: 'Normal', reason: 'Pulled', message: 'image pulled', count: 1, lastTimestamp: now },
      ]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'events', namespace: 'default', kubeconfig: kc });
    restore();
    assert.strictEqual(res.count, 2);
    assert.strictEqual(res.warnings, 1);
  } finally { fs.unlinkSync(kc); }
});

test('C08: secrets operation returns keys only (no values)', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({
      items: [{
        metadata: { name: 'db-creds', namespace: 'default', creationTimestamp: new Date().toISOString() },
        type: 'Opaque',
        data: {
          username: Buffer.from('admin').toString('base64'),
          password: Buffer.from('s3cr3t').toString('base64'),
        },
      }]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'secrets', namespace: 'default', kubeconfig: kc });
    restore();
    assert.strictEqual(res.count, 1);
    const secret = res.secrets[0];
    assert.ok(Array.isArray(secret.keys));
    assert.ok(secret.keys.includes('username'));
    assert.ok(secret.keys.includes('password'));
    // Values must NOT be present
    assert.strictEqual(secret.username, undefined);
    assert.strictEqual(secret.password, undefined);
  } finally { fs.unlinkSync(kc); }
});

test('C09: logs operation returns log text', async () => {
  const kc = writeTempKubeconfig();
  try {
    const logText = 'INFO starting server\nINFO listening on :8080\n';
    const restore = mockHttps({ status: 200, body: logText });
    const res = await k8sClient({ operation: 'logs', pod: 'web-pod', namespace: 'default', kubeconfig: kc });
    restore();
    assert.strictEqual(res.pod, 'web-pod');
    assert.ok(typeof res.log === 'string');
    assert.ok(res.log.includes('starting server'));
    assert.strictEqual(res.lines, 2);
  } finally { fs.unlinkSync(kc); }
});

test('C10: token override is used in Authorization header', async () => {
  const kc = writeTempKubeconfig({ token: 'original-token' });
  let capturedHeaders = null;
  const origRequest = https.request;
  https.request = (options, cb) => {
    capturedHeaders = options.headers;
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers    = {};
    const req = new EventEmitter();
    req.end = () => {
      setTimeout(() => {
        if (cb) cb(res);
        setTimeout(() => {
          res.emit('data', Buffer.from(JSON.stringify({ gitVersion: 'v1.28.0' })));
          res.emit('end');
        }, 5);
      }, 5);
    };
    req.write = () => {};
    req.destroy = () => {};
    return req;
  };
  try {
    await k8sClient({ operation: 'version', kubeconfig: kc, token: 'override-token' });
    assert.ok(capturedHeaders['Authorization'], 'Authorization header must be set');
    assert.ok(capturedHeaders['Authorization'].includes('override-token'));
    assert.ok(!capturedHeaders['Authorization'].includes('original-token'));
  } finally {
    https.request = origRequest;
    fs.unlinkSync(kc);
  }
});

// ═══════════════════════════════════════════════════════════
// D — Security (10)
// ═══════════════════════════════════════════════════════════

test('D01: NUL byte in kubeconfig path is blocked', async () => {
  await assert.rejects(
    () => k8sClient({ operation: 'version', kubeconfig: '/tmp/kube\0config' }),
    /NUL/i,
  );
});

test('D02: NUL byte in namespace is blocked', async () => {
  await assert.rejects(
    () => k8sClient({ operation: 'pods', namespace: 'ns\0evil', kubeconfig: '/tmp/k' }),
    /NUL/i,
  );
});

test('D03: secret values not included in response', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({
      items: [{
        metadata: { name: 's1', namespace: 'default', creationTimestamp: new Date().toISOString() },
        type: 'kubernetes.io/service-account-token',
        data: { token: Buffer.from('eyJhbGci...').toString('base64') },
      }]
    });
    const restore = mockHttps({ status: 200, body });
    const res = await k8sClient({ operation: 'secrets', namespace: 'default', kubeconfig: kc });
    restore();
    const secretJson = JSON.stringify(res);
    // The base64 value must not appear in the response
    assert.ok(!secretJson.includes('eyJhbGci'));
  } finally { fs.unlinkSync(kc); }
});

test('D04: insecure kubeconfig warns but allows request (mocked)', async () => {
  const kc = writeTempKubeconfig({ insecure: true });
  try {
    const restore = mockHttps({ status: 200, body: JSON.stringify({ gitVersion: 'v1.27.0' }) });
    const res = await k8sClient({ operation: 'version', kubeconfig: kc });
    restore();
    assert.ok(res.gitVersion);
  } finally { fs.unlinkSync(kc); }
});

test('D05: exec-based auth in kubeconfig throws clear error', async () => {
  const yaml = `apiVersion: v1
current-context: ctx
contexts:
- name: ctx
  context:
    cluster: cl
    user: u
clusters:
- name: cl
  cluster:
    server: https://localhost
users:
- name: u
  user:
    exec:
      command: aws
      args:
      - eks
      - get-token
`;
  const p = path.join(os.tmpdir(), `exec-kube-${Date.now()}.yaml`);
  fs.writeFileSync(p, yaml);
  try {
    await assert.rejects(
      () => k8sClient({ operation: 'version', kubeconfig: p }),
      /exec-based auth/i,
    );
  } finally { fs.unlinkSync(p); }
});

test('D06: API error exposes status code but not token in message', async () => {
  const kc = writeTempKubeconfig({ token: 'super-secret-token-xyz' });
  try {
    const body = JSON.stringify({ message: 'Forbidden', reason: 'Forbidden', code: 403 });
    const restore = mockHttps({ status: 403, body });
    let errMsg = '';
    try {
      await k8sClient({ operation: 'version', kubeconfig: kc });
    } catch (e) { errMsg = e.message; }
    restore();
    assert.ok(errMsg.includes('403'));
    // Token must not appear in error message
    assert.ok(!errMsg.includes('super-secret-token-xyz'));
  } finally { fs.unlinkSync(kc); }
});

test('D07: unknown kind in get gives friendly error', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'get', kind: 'unknownkind123', name: 'foo', kubeconfig: kc }),
      /unknown kind/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('D08: unknown kind in list gives friendly error with supported list', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'list', kind: 'frobnicator', kubeconfig: kc }),
      /unknown kind/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('D09: apply with manifest missing kind throws', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'apply', manifest: { apiVersion: 'v1', metadata: { name: 'foo' } }, kubeconfig: kc }),
      /kind/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('D10: apply with manifest missing apiVersion throws', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: '{}' });
    await assert.rejects(
      () => k8sClient({ operation: 'apply', manifest: { kind: 'ConfigMap', metadata: { name: 'foo' } }, kubeconfig: kc }),
      /apiVersion/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

// ═══════════════════════════════════════════════════════════
// E — Error paths (6)
// ═══════════════════════════════════════════════════════════

test('E01: nonexistent kubeconfig path throws helpful error', async () => {
  await assert.rejects(
    () => k8sClient({ operation: 'version', kubeconfig: '/nonexistent/path/to/kubeconfig.yaml' }),
    /kubeconfig/i,
  );
});

test('E02: API 404 error thrown with descriptive message', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({ message: 'pods "missing" not found', reason: 'NotFound', code: 404 });
    const restore = mockHttps({ status: 404, body });
    await assert.rejects(
      () => k8sClient({ operation: 'get', kind: 'pod', name: 'missing', namespace: 'default', kubeconfig: kc }),
      /404/,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('E03: API 401 Unauthorized throws descriptive error', async () => {
  const kc = writeTempKubeconfig();
  try {
    const body = JSON.stringify({ message: 'Unauthorized', code: 401 });
    const restore = mockHttps({ status: 401, body });
    await assert.rejects(
      () => k8sClient({ operation: 'namespaces', kubeconfig: kc }),
      /401/,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('E04: network error is surfaced with context', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ errorMsg: 'ECONNREFUSED' });
    await assert.rejects(
      () => k8sClient({ operation: 'version', kubeconfig: kc }),
      /ECONNREFUSED|network error/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('E05: invalid JSON response from API throws', async () => {
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: 'NOT JSON {{{' });
    await assert.rejects(
      () => k8sClient({ operation: 'version', kubeconfig: kc }),
      /invalid JSON/i,
    );
    restore();
  } finally { fs.unlinkSync(kc); }
});

test('E06: timeout is clamped to minimum 1000ms', async () => {
  // We just test that the option is accepted without error and doesn't blow up validation
  // (actual timeout behaviour can't be easily tested in <1s offline)
  const kc = writeTempKubeconfig();
  try {
    const restore = mockHttps({ status: 200, body: JSON.stringify({ gitVersion: 'v1.28.0' }) });
    const res = await k8sClient({ operation: 'version', kubeconfig: kc, timeout: 1 }); // below min
    restore();
    // Should succeed; timeout was clamped to 1000ms
    assert.ok(res.gitVersion);
  } finally { fs.unlinkSync(kc); }
});

// ─── run ─────────────────────────────────────────────────────────────────────
console.log('\nSection 242 — k8s_client offline tests\n');
runAll();
