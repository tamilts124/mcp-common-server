"use strict";
// utilSchemas75.js — schema for k8s_client tool
const UTIL_SCHEMAS_75 = [
  {
    name: "k8s_client",
    description: "Zero-dependency Kubernetes API client (pure Node.js https; no npm deps). Reads kubeconfig from disk (explicit path, KUBECONFIG env, ~/.kube/config) or in-cluster service-account token. Operations: version (cluster version info), namespaces (list all namespaces), pods (list pods with phase/ready/restarts), deployments (list deployments with replica status), services (list services with type/ports), nodes (list nodes with role/version/resources), configmaps (list configmaps with key names), secrets (list secrets — key names only, no values), events (list events sorted by lastTimestamp, warnings flagged), ingresses (list ingresses with hosts/paths/LB), logs (fetch pod log tail), get (get a named resource), list (list any resource kind), apply (create or update a manifest), delete (delete a named resource), rollout (rollout status + history for deployments/daemonsets/statefulsets), top_pods (pod CPU/memory metrics, requires metrics-server), top_nodes (node CPU/memory metrics, requires metrics-server). Auth: kubeconfig token, client-cert/key, Basic, in-cluster service account. Security: 32 MB response cap (4 MB for logs); NUL-byte guards on kubeconfig/namespace; timeout clamped 1000–300000 ms; secret values never returned.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description: "Operation to perform. One of: version, namespaces, pods, deployments, services, nodes, configmaps, secrets, events, ingresses, logs, get, list, apply, delete, rollout, top_pods, top_nodes.",
          enum: [
            "version", "namespaces", "pods", "deployments", "services", "nodes",
            "configmaps", "secrets", "events", "ingresses", "logs", "get", "list",
            "apply", "delete", "rollout", "top_pods", "top_nodes",
          ],
        },
        // ── Connection / auth ─────────────────────────────────────────────
        kubeconfig: {
          type: "string",
          description: "Explicit path to a kubeconfig file. Falls back to KUBECONFIG env, then ~/.kube/config, then in-cluster service-account.",
        },
        context: {
          type: "string",
          description: "Kubeconfig context name to use (overrides current-context in the file).",
        },
        server: {
          type: "string",
          description: "Override the Kubernetes API server URL (e.g. 'https://127.0.0.1:6443').",
        },
        token: {
          type: "string",
          description: "Bearer token to use for authentication, overriding the kubeconfig user credentials.",
        },
        insecure: {
          type: "boolean",
          description: "Skip TLS certificate verification (insecure — for local/dev clusters only). Default: false.",
        },
        timeout: {
          type: "number",
          description: "Request timeout in milliseconds (1000–300000, default 30000). Logs endpoint defaults to 60000.",
        },
        // ── Common filters ────────────────────────────────────────────────
        namespace: {
          type: "string",
          description: "Kubernetes namespace. Use 'all' or '*' for cluster-wide listing on operations that support it (pods, deployments, services, configmaps, secrets, events, ingresses, top_pods). Default: namespace from kubeconfig context, or 'default'.",
        },
        label_selector: {
          type: "string",
          description: "Label selector filter for list operations (e.g. 'app=nginx,env=prod').",
        },
        field_selector: {
          type: "string",
          description: "Field selector filter for list operations (e.g. 'status.phase=Running').",
        },
        limit: {
          type: "number",
          description: "Maximum number of items to return per list operation (1–10000). Kubernetes may paginate; use continue_token to fetch next page.",
        },
        continue_token: {
          type: "string",
          description: "Pagination continue token from a previous list response to fetch the next page of results.",
        },
        // ── logs operation ────────────────────────────────────────────────
        pod: {
          type: "string",
          description: "[logs] Pod name to fetch logs from. Required for 'logs'.",
        },
        container: {
          type: "string",
          description: "[logs] Container name within the pod (required only for multi-container pods).",
        },
        tail_lines: {
          type: "number",
          description: "[logs] Number of log lines to return from the end of the log (default: 100, max: 100000).",
        },
        since_seconds: {
          type: "number",
          description: "[logs] Only return logs newer than this many seconds ago.",
        },
        previous: {
          type: "boolean",
          description: "[logs] Return logs from the previous (terminated) container instance. Default: false.",
        },
        // ── get / delete operations ───────────────────────────────────────
        kind: {
          type: "string",
          description: "[get, delete, list, rollout] Resource kind, e.g. 'pod', 'deployment', 'service', 'configmap', 'secret', 'node', 'namespace', 'ingress', 'job', 'cronjob', 'daemonset', 'statefulset', 'replicaset', 'pv', 'pvc', 'sa', 'role', 'clusterrole', 'rolebinding', 'clusterrolebinding', 'hpa', 'storageclass', 'networkpolicy'. Aliases like 'rs', 'ds', 'ing', 'sc', 'sa', 'pv', 'pvc' are accepted.",
        },
        name: {
          type: "string",
          description: "[get, delete, rollout] Name of the specific resource to fetch or delete.",
        },
        grace_period: {
          type: "number",
          description: "[delete] Grace period in seconds before forceful termination (0 = immediate). Default: Kubernetes default for the resource type.",
        },
        // ── apply operation ───────────────────────────────────────────────
        manifest: {
          description: "[apply] Kubernetes manifest as a JSON object (or a JSON-encoded string). Must include 'apiVersion', 'kind', and 'metadata.name'. Namespace defaults to the connection namespace if not specified in the manifest.",
        },
      },
    },
  },
];
module.exports = { UTIL_SCHEMAS_75 };
