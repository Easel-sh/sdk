import { createHttp, EaselApiError, newIdempotencyKey, sleep, type ClientOptions, type Http } from "./http.js";
import { verifyWebhook, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from "./webhook-signature.js";
import type {
  AddProjectDomainRequest,
  AddWildcardDomainRequest,
  CreateDeploymentRequest,
  CreateDeploymentResponse,
  CreateDeploymentUploadRequest,
  CreateEnvBody,
  CreateEnvRequest,
  CreateEnvResponse,
  CreateProjectRequest,
  CreateTokenRequest,
  CreateTokenResponse,
  CreateWebhookRequest,
  CreateWebhookResponse,
  Deployment,
  DeploymentFileRef,
  DeploymentGitMetadata,
  DeploymentInlineFile,
  DeploymentListResponse,
  DeploymentLogsResponse,
  DeploymentMeta,
  DeploymentResponse,
  DeploymentStatus,
  DeploymentTarget,
  DeploymentUploadResponse,
  DeploymentUploadStatusResponse,
  DomainTarget,
  DomainTargetResponse,
  EnvListResponse,
  EnvResponse,
  EnvVar,
  MissingFilesResponse,
  Project,
  ProjectDomain,
  ProjectDomainListResponse,
  ProjectDomainResponse,
  ProjectListResponse,
  ProjectResponse,
  RuntimeLogsResponse,
  Token,
  TokenListResponse,
  TrafficResponse,
  UpdateEnvRequest,
  UpdateProjectRequest,
  UsageResponse,
  Webhook,
  WebhookEvent,
  WebhookListResponse,
  WhoamiResponse,
  WildcardDomain,
  WildcardDomainListResponse,
  WildcardDomainResponse,
} from "./types.js";

/** Statuses a deployment never leaves. */
export const TERMINAL_DEPLOYMENT_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "READY",
  "ERROR",
  "CANCELLED",
  "SKIPPED",
  "SUPERSEDED",
  "SPUN_DOWN",
]);

/** File lists up to this size go inline in one request; larger ones upload only the files Easel doesn't have. */
export const INLINE_FILES_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 8;

/** A file to deploy, as text or bytes. `file` is a POSIX path relative to the source root. */
export interface SourceFile {
  file: string;
  data: string | Uint8Array;
  /** Unix mode bits, e.g. 0o755 for an executable. Defaults to 0o644. */
  mode?: number;
}

/** A gzip tarball of the source: bytes, a Blob, or a stream (such as `tar czf -` stdout). */
export type SourceArchive = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export interface CreateDeploymentInput {
  /** Project id or slug. */
  project: string;
  target?: DeploymentTarget;
  meta?: DeploymentMeta;
  /** Exactly one of `archive` or `files`. */
  archive?: SourceArchive;
  files?: SourceFile[];
  prebuilt?: boolean;
  gitMetadata?: DeploymentGitMetadata;
  /** Defaults to a new key per call, so the SDK's own retries never create two deployments. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface WaitOptions {
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Poll interval. Default 2 seconds. */
  intervalMs?: number;
  /** Called whenever the status changes, including the first read. */
  onStatus?: (deployment: Deployment) => void;
  signal?: AbortSignal;
}

export class DeploymentWaitTimeoutError extends Error {
  constructor(readonly deployment: Deployment) {
    super(`Timed out waiting for deployment ${deployment.id} (last status ${deployment.status})`);
    this.name = "DeploymentWaitTimeoutError";
  }
}

const enc = encodeURIComponent;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Which way `deployments.create` sends `files`: inline under {@link INLINE_FILES_MAX_BYTES}, otherwise deduplicated uploads. */
export function chooseFilesPath(files: SourceFile[]): "inline" | "dedup" {
  let total = 0;
  for (const file of files) {
    total += typeof file.data === "string" ? utf8(file.data).length : file.data.length;
    if (total > INLINE_FILES_MAX_BYTES) return "dedup";
  }
  return "inline";
}

/** `SourceFile.mode` is permission bits; the API takes a full regular-file mode. */
function fileMode(file: SourceFile): number {
  return 0o100000 | (file.mode ?? 0o644);
}

function toInlineFile(file: SourceFile): DeploymentInlineFile {
  return typeof file.data === "string"
    ? { file: file.file, data: file.data, encoding: "utf-8", mode: fileMode(file) }
    : { file: file.file, data: toBase64(file.data), encoding: "base64", mode: fileMode(file) };
}

function deploymentsApi(http: Http) {
  async function uploadMissing(files: SourceFile[], signal?: AbortSignal): Promise<DeploymentFileRef[]> {
    const hashed = await Promise.all(
      files.map(async (file) => {
        const bytes = typeof file.data === "string" ? utf8(file.data) : file.data;
        const hex = await sha256Hex(bytes);
        return { file, bytes, hex, ref: { file: file.file, contentHash: `sha256:${hex}`, size: bytes.length, mode: fileMode(file) } };
      }),
    );
    const { missing } = await http.request<MissingFilesResponse>("POST", "/v1/files/missing", {
      json: { hashes: [...new Set(hashed.map((entry) => entry.ref.contentHash))] },
      signal,
    });
    const missingSet = new Set(missing);
    const seen = new Set<string>();
    const toUpload = hashed.filter((entry) => {
      if (!missingSet.has(entry.ref.contentHash) || seen.has(entry.hex)) return false;
      seen.add(entry.hex);
      return true;
    });
    await mapPool(toUpload, UPLOAD_CONCURRENCY, async (entry) => {
      // Content-addressed: sending the same bytes twice is harmless, so the
      // hash doubles as the idempotency key and lets a 5xx be retried.
      await http.request("POST", "/v1/files", {
        body: entry.bytes as BodyInit,
        headers: { "x-content-hash": entry.hex, "Content-Type": "application/octet-stream" },
        idempotencyKey: entry.ref.contentHash,
        signal,
      });
    });
    return hashed.map((entry) => entry.ref);
  }

  async function get(deploymentId: string, signal?: AbortSignal): Promise<Deployment> {
    return (await http.request<DeploymentResponse>("GET", `/v1/deployments/${enc(deploymentId)}`, { signal })).deployment;
  }

  /** Poll until the deployment reaches a terminal status (READY, ERROR, CANCELLED, …). */
  async function wait(deploymentId: string, options: WaitOptions = {}): Promise<Deployment> {
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const intervalMs = options.intervalMs ?? 2000;
    const startedAt = Date.now();
    let deployment = await get(deploymentId, options.signal);
    let lastStatus: DeploymentStatus | null = null;
    for (;;) {
      if (deployment.status !== lastStatus) {
        lastStatus = deployment.status;
        options.onStatus?.(deployment);
      }
      if (TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status)) return deployment;
      if (Date.now() - startedAt > timeoutMs) throw new DeploymentWaitTimeoutError(deployment);
      await sleep(intervalMs, options.signal);
      deployment = await get(deploymentId, options.signal);
    }
  }

  return {
    /**
     * Deploy source to a project. Pass `archive` (a gzip tarball) or `files`;
     * `files` go inline when small and as deduplicated uploads when large.
     * Returns once the deployment is queued; use `deployments.wait` to follow it.
     */
    async create(input: CreateDeploymentInput): Promise<Deployment> {
      if (Boolean(input.archive) === Boolean(input.files)) {
        throw new Error("deployments.create: pass exactly one of archive or files");
      }
      const idempotencyKey = input.idempotencyKey ?? newIdempotencyKey();
      const path = `/v1/projects/${enc(input.project)}/deployments`;

      if (input.archive) {
        const response = await http.request<CreateDeploymentResponse>("POST", path, {
          query: { target: input.target ?? "preview", prebuilt: input.prebuilt ? "true" : undefined },
          body: input.archive as BodyInit,
          headers: {
            "Content-Type": "application/gzip",
            ...(input.meta ? { "x-easel-meta": JSON.stringify(input.meta) } : {}),
            ...(input.gitMetadata ? { "x-easel-git": JSON.stringify(input.gitMetadata) } : {}),
          },
          idempotencyKey,
          signal: input.signal,
        });
        return response.deployment;
      }

      const files = input.files!;
      const body: CreateDeploymentRequest = {
        target: input.target ?? "preview",
        ...(input.meta ? { meta: input.meta } : {}),
        ...(input.prebuilt ? { prebuilt: true } : {}),
        ...(input.gitMetadata ? { gitMetadata: input.gitMetadata } : {}),
        ...(chooseFilesPath(files) === "inline"
          ? { inlineFiles: files.map(toInlineFile) }
          : { files: await uploadMissing(files, input.signal) }),
      };
      const response = await http.request<CreateDeploymentResponse>("POST", path, {
        json: body,
        idempotencyKey,
        signal: input.signal,
      });
      return response.deployment;
    },

    /**
     * A single-use URL a sandbox can PUT a gzip tarball to without a token.
     * See {@link sandboxUploadScript} for the command to run in the sandbox.
     */
    async createUpload(
      input: { project: string; idempotencyKey?: string } & CreateDeploymentUploadRequest,
    ): Promise<DeploymentUploadResponse> {
      const { project, idempotencyKey, ...body } = input;
      return http.request<DeploymentUploadResponse>("POST", `/v1/projects/${enc(project)}/deployment-uploads`, {
        json: body,
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      });
    },

    /** Whether an upload URL has been used, and the deployment it created. */
    async getUpload(uploadId: string): Promise<DeploymentUploadStatusResponse> {
      return http.request<DeploymentUploadStatusResponse>("GET", `/v1/deployment-uploads/${enc(uploadId)}`);
    },

    get,

    async list(input: {
      project: string;
      target?: DeploymentTarget;
      status?: DeploymentStatus[];
      limit?: number;
      cursor?: string;
    }): Promise<DeploymentListResponse> {
      return http.request<DeploymentListResponse>("GET", `/v1/projects/${enc(input.project)}/deployments`, {
        query: {
          target: input.target,
          status: input.status?.join(","),
          limit: input.limit,
          cursor: input.cursor,
        },
      });
    },

    wait,

    async logs(deploymentId: string): Promise<DeploymentLogsResponse["logs"]> {
      return (await http.request<DeploymentLogsResponse>("GET", `/v1/deployments/${enc(deploymentId)}/logs`)).logs;
    },

    /** Requests the deployment served, with each function invocation's first log line. */
    async runtimeLogs(deploymentId: string, options: { since?: string; limit?: number } = {}): Promise<RuntimeLogsResponse["records"]> {
      return (
        await http.request<RuntimeLogsResponse>("GET", `/v1/deployments/${enc(deploymentId)}/runtime-logs`, { query: options })
      ).records;
    },

    async cancel(deploymentId: string): Promise<Deployment> {
      return (await http.request<DeploymentResponse>("PATCH", `/v1/deployments/${enc(deploymentId)}/cancel`)).deployment;
    },

    /**
     * Serve `deploymentId` in production. A preview is rebuilt with
     * production env first: the result's `deployment` is then a new one
     * (`rebuilt: true`) to `deployments.wait` on.
     */
    async promote(input: { project: string; deploymentId: string }): Promise<TrafficResponse> {
      return http.request<TrafficResponse>("POST", `/v1/projects/${enc(input.project)}/promote/${enc(input.deploymentId)}`);
    },

    /** Point production back at an earlier deployment, without a rebuild. */
    async rollback(input: { project: string; deploymentId: string }): Promise<TrafficResponse> {
      return http.request<TrafficResponse>("POST", `/v1/projects/${enc(input.project)}/rollback/${enc(input.deploymentId)}`);
    },
  };
}

function projectsApi(http: Http) {
  async function get(project: string): Promise<Project> {
    return (await http.request<ProjectResponse>("GET", `/v1/projects/${enc(project)}`)).project;
  }
  return {
    async list(): Promise<Project[]> {
      return (await http.request<ProjectListResponse>("GET", "/v1/projects")).projects;
    },
    get,
    async create(input: CreateProjectRequest & { idempotencyKey?: string }): Promise<Project> {
      const { idempotencyKey, ...body } = input;
      return (
        await http.request<ProjectResponse>("POST", "/v1/projects", {
          json: body,
          idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
        })
      ).project;
    },
    /**
     * The project named `name`, created with `settings` if it doesn't exist.
     * Safe to call on every publish.
     */
    async ensure(name: string, settings: Omit<CreateProjectRequest, "name" | "workspace"> = {}): Promise<Project> {
      try {
        return await get(name);
      } catch (error) {
        if (!(error instanceof EaselApiError) || error.status !== 404) throw error;
      }
      try {
        return (
          await http.request<ProjectResponse>("POST", "/v1/projects", {
            json: { name, ...settings },
            idempotencyKey: newIdempotencyKey(),
          })
        ).project;
      } catch (error) {
        // Created concurrently by another publish.
        if (error instanceof EaselApiError && error.code === "project_name_taken") {
          const existing = (await http.request<ProjectListResponse>("GET", "/v1/projects")).projects.find(
            (project) => project.name === name,
          );
          if (existing) return existing;
        }
        throw error;
      }
    },
    async update(project: string, changes: UpdateProjectRequest): Promise<Project> {
      return (await http.request<ProjectResponse>("PATCH", `/v1/projects/${enc(project)}`, { json: changes })).project;
    },
    /** Delete a project and everything in it. Runs in the background. */
    async delete(project: string): Promise<void> {
      await http.request("DELETE", `/v1/projects/${enc(project)}`);
    },
  };
}

function envApi(http: Http) {
  return {
    async list(project: string, options: { decrypt?: boolean } = {}): Promise<EnvVar[]> {
      return (
        await http.request<EnvListResponse>("GET", `/v1/projects/${enc(project)}/env`, {
          query: { decrypt: options.decrypt ? "true" : undefined },
        })
      ).envs;
    },
    /** Create variables, replacing any with the same key and branch. */
    async upsert(project: string, vars: CreateEnvBody): Promise<EnvVar[]> {
      return (
        await http.request<CreateEnvResponse>("POST", `/v1/projects/${enc(project)}/env`, {
          query: { upsert: "true" },
          json: vars,
        })
      ).created;
    },
    async create(project: string, vars: CreateEnvRequest | CreateEnvRequest[]): Promise<EnvVar[]> {
      return (await http.request<CreateEnvResponse>("POST", `/v1/projects/${enc(project)}/env`, { json: vars })).created;
    },
    async update(project: string, envId: string, changes: UpdateEnvRequest): Promise<EnvVar> {
      return (await http.request<EnvResponse>("PATCH", `/v1/projects/${enc(project)}/env/${enc(envId)}`, { json: changes })).env;
    },
    async delete(project: string, envId: string): Promise<void> {
      await http.request("DELETE", `/v1/projects/${enc(project)}/env/${enc(envId)}`);
    },
  };
}

function domainsApi(http: Http) {
  const base = (project: string) => `/v1/projects/${enc(project)}/domains`;
  return {
    async list(project: string): Promise<ProjectDomain[]> {
      return (await http.request<ProjectDomainListResponse>("GET", base(project))).domains;
    },
    /**
     * Add a hostname to a project. A name under one of the workspace's
     * wildcard domains is live at once; another domain comes back with the
     * `records` to add. A domain another workspace holds throws an
     * {@link EaselApiError} with code `domain_in_use` and the record that
     * proves ownership; one on another project in the workspace throws
     * `domain_in_project` unless `move: true` is set.
     */
    async add(project: string, input: AddProjectDomainRequest): Promise<ProjectDomain> {
      return (
        await http.request<ProjectDomainResponse>("POST", base(project), { json: input, idempotencyKey: newIdempotencyKey() })
      ).domain;
    },
    async get(project: string, domain: string): Promise<ProjectDomain> {
      return (await http.request<ProjectDomainResponse>("GET", `${base(project)}/${enc(domain)}`)).domain;
    },
    /** Check DNS now instead of waiting for the next automatic check. */
    async verify(project: string, domain: string): Promise<ProjectDomain> {
      return (await http.request<ProjectDomainResponse>("POST", `${base(project)}/${enc(domain)}/verify`)).domain;
    },
    async remove(project: string, domain: string): Promise<void> {
      await http.request("DELETE", `${base(project)}/${enc(domain)}`);
    },
  };
}

function wildcardDomainsApi(http: Http) {
  return {
    async list(): Promise<WildcardDomain[]> {
      return (await http.request<WildcardDomainListResponse>("GET", "/v1/wildcard-domains")).wildcardDomains;
    },
    async add(input: AddWildcardDomainRequest): Promise<WildcardDomain> {
      return (await http.request<WildcardDomainResponse>("POST", "/v1/wildcard-domains", { json: input, idempotencyKey: newIdempotencyKey() })).wildcardDomain;
    },
    async get(domain: string): Promise<WildcardDomain> {
      return (await http.request<WildcardDomainResponse>("GET", `/v1/wildcard-domains/${enc(domain)}`)).wildcardDomain;
    },
    async verify(domain: string): Promise<WildcardDomain> {
      return (await http.request<WildcardDomainResponse>("POST", `/v1/wildcard-domains/${enc(domain)}/verify`)).wildcardDomain;
    },
    async remove(domain: string): Promise<void> {
      await http.request("DELETE", `/v1/wildcard-domains/${enc(domain)}`);
    },
  };
}

function domainTargetApi(http: Http) {
  return {
    async get(): Promise<DomainTarget | null> {
      return (await http.request<DomainTargetResponse>("GET", "/v1/domain-target")).domainTarget;
    },
    async set(host: string): Promise<DomainTarget> {
      return (await http.request<DomainTargetResponse>("PUT", "/v1/domain-target", { json: { host } })).domainTarget!;
    },
    async verify(): Promise<DomainTarget> {
      return (await http.request<DomainTargetResponse>("POST", "/v1/domain-target/verify")).domainTarget!;
    },
    async remove(): Promise<void> {
      await http.request("DELETE", "/v1/domain-target");
    },
  };
}

function webhooksApi(http: Http) {
  return {
    async list(): Promise<Webhook[]> {
      return (await http.request<WebhookListResponse>("GET", "/v1/webhooks")).webhooks;
    },
    /** The signing secret is only returned here. */
    async create(input: CreateWebhookRequest): Promise<CreateWebhookResponse> {
      return http.request<CreateWebhookResponse>("POST", "/v1/webhooks", { json: input, idempotencyKey: newIdempotencyKey() });
    },
    async delete(webhookId: string): Promise<void> {
      await http.request("DELETE", `/v1/webhooks/${enc(webhookId)}`);
    },
    /**
     * Check a delivery's signature and return its event. Pass the body exactly
     * as received (before JSON parsing) and the request headers. Throws when
     * the signature is wrong or the timestamp is more than 5 minutes off.
     * Dedupe on the event's `id`: retries resend the same one.
     */
    async verify(rawBody: string, headers: Headers | Record<string, string | null | undefined>, secret: string): Promise<WebhookEvent> {
      const read = (name: string) => {
        if (headers instanceof Headers) return headers.get(name);
        const wanted = name.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === wanted) return value;
        }
        return undefined;
      };
      const valid = await verifyWebhook({
        rawBody,
        signature: read(WEBHOOK_SIGNATURE_HEADER),
        timestamp: read(WEBHOOK_TIMESTAMP_HEADER),
        secret,
      });
      if (!valid) throw new Error("Invalid Easel webhook signature");
      return JSON.parse(rawBody) as WebhookEvent;
    },
  };
}

function tokensApi(http: Http) {
  return {
    async list(): Promise<Token[]> {
      return (await http.request<TokenListResponse>("GET", "/v1/tokens")).tokens;
    },
    /**
     * Mint a token within this client's own token: never more permissions,
     * projects or lifetime. The secret is only returned here.
     */
    async create(input: CreateTokenRequest): Promise<CreateTokenResponse> {
      return http.request<CreateTokenResponse>("POST", "/v1/tokens", { json: input, idempotencyKey: newIdempotencyKey() });
    },
    async revoke(tokenId: string): Promise<void> {
      await http.request("DELETE", `/v1/tokens/${enc(tokenId)}`);
    },
  };
}

export type EaselClient = ReturnType<typeof createClient>;

/**
 * An Easel API client. Plain async functions over `fetch`: works in route
 * handlers, queue workers, CLIs and edge runtimes alike.
 *
 * ```ts
 * const easel = createClient({ token: process.env.EASEL_TOKEN! });
 * const project = await easel.projects.ensure("trip-planner");
 * const deployment = await easel.deployments.create({ project: project.id, target: "production", files });
 * await easel.deployments.wait(deployment.id);
 * ```
 */
export function createClient(options: ClientOptions) {
  const http = createHttp(options);
  return {
    baseUrl: http.baseUrl,
    async whoami(): Promise<WhoamiResponse> {
      return http.request<WhoamiResponse>("GET", "/v1/whoami");
    },
    projects: projectsApi(http),
    env: envApi(http),
    deployments: deploymentsApi(http),
    domains: domainsApi(http),
    wildcardDomains: wildcardDomainsApi(http),
    domainTarget: domainTargetApi(http),
    usage: {
      /** Usage per project between `from` and `to` (ISO dates). Defaults to this month so far. */
      async get(query: { from?: string; to?: string; projectId?: string } = {}): Promise<UsageResponse> {
        return http.request<UsageResponse>("GET", "/v1/usage", { query });
      },
    },
    webhooks: webhooksApi(http),
    tokens: tokensApi(http),
    /** Low-level access for endpoints the client doesn't wrap yet. */
    request: http.request,
  };
}

/**
 * The one command a sandbox runs to deploy its working directory to an
 * upload URL from `deployments.createUpload`. It needs `tar`, `curl` and
 * outbound HTTPS. Easel drops `.env` files and `.git` on its side whatever
 * is sent; the excludes here only save bandwidth.
 */
export function sandboxUploadScript(uploadUrl: string, options: { cwd?: string; exclude?: string[] } = {}): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const excludes = ["node_modules", ".git", ".env", ".env.*", ...(options.exclude ?? [])]
    .map((pattern) => `--exclude=${quote(pattern)}`)
    .join(" ");
  const cd = options.cwd ? `cd ${quote(options.cwd)} && ` : "";
  return `${cd}tar czf - ${excludes} . | curl -sSf -X PUT -H 'Content-Type: application/gzip' -T - ${quote(uploadUrl)}`;
}
