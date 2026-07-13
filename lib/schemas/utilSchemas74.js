"use strict";
// utilSchemas74: registry_client

const UTIL_SCHEMAS_74 = [
  {
    name: "registry_client",
    description:
      "Zero-dependency Docker/OCI container registry client (pure Node.js https; no npm deps). " +
      "Queries any OCI Distribution API v2 compliant registry — Docker Hub, GHCR, GCR, ECR, " +
      "Azure CR, Quay, or a self-hosted registry — without requiring a Docker daemon or CLI. " +
      "Operations: " +
      "ping (verify the registry speaks the Distribution API — returns reachable, apiVersion, authScheme); " +
      "tags (list all tags for an image, paginated, capped at 5,000); " +
      "manifest (fetch and decode the manifest — schema v1/v2, OCI image index, OCI image manifest — " +
        "returns manifestType, schemaVersion, layers[], platforms[] for multi-arch indexes, config descriptor); " +
      "config (fetch the image config blob — returns OS, architecture, Env, Cmd, Entrypoint, WorkingDir, " +
        "Labels, ExposedPorts, Volumes, history entries, rootfs diff IDs); " +
      "layers (list layer descriptors from the manifest — digest, mediaType, size, totalBytes, totalMB); " +
      "exists (HEAD request — check whether a tag/digest exists, returns boolean + digest); " +
      "digest (resolve a tag to its canonical content-addressable sha256 digest). " +
      "Authentication: anonymous (no creds), Bearer token (auto-negotiated from 401 challenge), " +
      "Basic (username + password), or pre-obtained Bearer token. " +
      "Docker Hub images are resolved automatically: 'nginx' -> library/nginx on registry-1.docker.io. " +
      "Security: 16 MB response cap; NUL-byte guard on image/registry/repository inputs; " +
      "20 s default timeout (configurable up to 300 s).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["ping", "tags", "manifest", "config", "layers", "exists", "digest"],
          description:
            "ping: verify registry speaks Distribution API v2 (requires 'registry'). " +
            "tags: list all tags for an image. " +
            "manifest: fetch and decode the image manifest (schema v1/v2, OCI). " +
            "config: fetch the image config blob (OS, arch, Env, Cmd, Labels, history). " +
            "layers: list layer descriptors (digest, size) from the manifest. " +
            "exists: check whether a specific tag or digest exists (HEAD request). " +
            "digest: resolve a tag to its canonical sha256 content-addressable digest.",
        },
        // image short-hand (auto-parses registry, repository, reference)
        image: {
          type: "string",
          description:
            "Full image reference in docker-pull format, e.g. 'nginx:1.25', " +
            "'ghcr.io/owner/repo:latest', 'myrepo/myimage@sha256:abc123...'. " +
            "Parsed automatically: if no registry hostname is found, defaults to Docker Hub. " +
            "Official Docker Hub images (single word like 'ubuntu') expand to library/ubuntu. " +
            "Provide 'image' OR ('registry' + 'repository'), not both.",
        },
        // explicit registry + repository + reference (alternative to 'image')
        registry: {
          type: "string",
          description:
            "Registry hostname, e.g. 'registry-1.docker.io', 'ghcr.io', 'gcr.io', " +
            "'public.ecr.aws', 'localhost:5000'. " +
            "For ping this is the only required field. " +
            "'docker.io' is normalised to 'registry-1.docker.io' automatically.",
        },
        repository: {
          type: "string",
          description:
            "Repository path within the registry, e.g. 'library/nginx', 'myorg/myimage'. " +
            "Required when 'registry' is provided instead of 'image'.",
        },
        reference: {
          type: "string",
          description:
            "Tag or digest to target (default: 'latest'). " +
            "Examples: '1.25', 'stable', 'sha256:abc123...'. " +
            "Overrides the reference parsed from 'image'.",
        },
        tag: {
          type: "string",
          description: "Alias for 'reference' — the image tag, e.g. 'latest', '1.25-alpine'.",
        },
        // auth
        username: {
          type: "string",
          description:
            "Registry username for Basic or Bearer-negotiated auth. " +
            "Combine with 'password'. For Docker Hub use your Docker ID.",
        },
        password: {
          type: "string",
          description:
            "Registry password or access token for Basic / Bearer auth. " +
            "For Docker Hub this can be a Personal Access Token (PAT) instead of your password.",
        },
        token: {
          type: "string",
          description:
            "Pre-obtained Bearer token string. Use when you already have a token " +
            "(e.g. from a CI/CD system). If provided, 'username'/'password' are ignored.",
        },
        // tags op
        limit: {
          type: "number",
          description:
            "[tags] Maximum number of tags to return per page (1–5000, default 1000). " +
            "The registry may return fewer depending on its own page-size limits.",
        },
        last: {
          type: "string",
          description:
            "[tags] Pagination cursor — last tag from a previous response. " +
            "Used with the 'next' value returned by a prior tags call.",
        },
        // misc
        insecure: {
          type: "boolean",
          description:
            "Use HTTP instead of HTTPS (for local / private registries without TLS). " +
            "Default: false.",
        },
        timeout: {
          type: "number",
          description:
            "Request timeout in milliseconds (1000–300000; default 20000). " +
            "Applies per HTTP request, not to the total operation.",
        },
      },
      required: ["operation"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_74 };
