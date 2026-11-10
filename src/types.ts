/** Request and response shapes for the Easel `/v1` API. */

import type { PermissionMap } from "./permissions.js";

// ---------------------------------------------------------------------------
// Errors and pagination
// ---------------------------------------------------------------------------

export interface DnsRecord {
  type: "A" | "AAAA" | "CNAME" | "TXT" | "NS";
  /** Relative to the zone (`@`, `www`, `_acme-challenge`) or a full name. */
  name: string;
  value: string;
}

/** Every non-2xx response. `records` is set when the fix is a DNS record. */
export interface ApiErrorBody {
  error: string;
  code?: string;
  records?: DnsRecord[];
}

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Workspaces and users
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  slug: string | null;
}

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface WhoamiResponse {
  user: User;
  workspace: Workspace;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  slug: string | null;
  /** The workspace's ID. */
  organizationId: string;
  /** Root Directory relative to the source root; null when the app is at the root. */
  rootDirectory: string | null;
  /** Framework preset slug; null for "Other", or until a build detects one. */
  framework: string | null;
  buildCommand: string | null;
  installCommand: string | null;
  outputDirectory: string | null;
  createdAt: string;
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface ProjectResponse {
  project: Project;
}

/** POST /v1/projects */
export interface CreateProjectRequest {
  /** Only checked against the token's workspace; tokens act on one workspace. */
  workspace?: string;
  name: string;
  /** Framework preset slug. Omit it to detect the framework at build time; `null` is "Other" (no preset). */
  framework?: string | null;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
}

/** PATCH /v1/projects/:idOrName. Omitted fields are unchanged; null clears. */
export interface UpdateProjectRequest {
  name?: string;
  /** Framework preset slug; `null` is "Other" (no preset). */
  framework?: string | null;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export type DeploymentStatus =
  | "READY"
  | "ERROR"
  | "BUILDING"
  | "QUEUED"
  | "PROVISIONING"
  | "ASSIGNING_DOMAINS"
  | "CANCELLED"
  | "SKIPPED"
  | "SUPERSEDED"
  | "SPUN_DOWN";

export type DeploymentTarget = "production" | "preview";

/** Up to 20 string pairs the caller attaches to a deployment, such as its own app version. */
export type DeploymentMeta = Record<string, string>;

export const DEPLOYMENT_META_LIMITS = {
  maxEntries: 20,
  maxKeyLength: 64,
  maxTotalBytes: 1024,
} as const;

export interface DeploymentAlias {
  id: string;
  alias: string;
  url: string;
}

export interface DeploymentGitSource {
  branch?: string;
  commitHash?: string;
  commitMessage?: string;
  repository?: string;
  pusher?: string;
  pullRequestNumber?: number;
}

export interface DeploymentSummary {
  id: string;
  projectId: string;
  source: "GIT" | "CLI";
  target: DeploymentTarget;
  status: DeploymentStatus;
  queuedAt: string | null;
  buildingAt: string | null;
  readyAt: string | null;
  errorAt: string | null;
  cancelledAt: string | null;
  primaryUrl: string | null;
  gitSource: DeploymentGitSource | null;
  meta: DeploymentMeta | null;
}

export interface Deployment extends DeploymentSummary {
  aliases: DeploymentAlias[];
}

export interface DeploymentListResponse {
  deployments: DeploymentSummary[];
  pagination: Pagination;
}

export interface DeploymentResponse {
  deployment: Deployment;
}

/** A file already uploaded with `POST /v1/files`, referenced by hash. */
export interface DeploymentFileRef {
  file: string;
  contentHash: string;
  size: number;
  mode: number;
}

/** A file sent inline in the deployment request. */
export interface DeploymentInlineFile {
  file: string;
  data: string;
  encoding?: "utf-8" | "base64";
  mode?: number;
}

export interface DeploymentGitMetadata {
  commitHash?: string;
  commitMessage?: string;
  branch?: string;
  repository?: string;
}

/**
 * POST /v1/projects/:id/deployments as JSON. Exactly one of `files`,
 * `inlineFiles` or `archive` is required. A gzip body (`Content-Type:
 * application/gzip`) is the archive form without a prior upload.
 */
export interface CreateDeploymentRequest {
  workspace?: string;
  target?: DeploymentTarget;
  meta?: DeploymentMeta;
  files?: DeploymentFileRef[];
  inlineFiles?: DeploymentInlineFile[];
  archive?: { contentHash: string; size: number };
  /** The uploaded files are already built output; skip the build. */
  prebuilt?: boolean;
  gitMetadata?: DeploymentGitMetadata;
}

export type CreateDeploymentResponse = DeploymentResponse;

/** POST /v1/projects/:id/deployment-uploads */
export interface CreateDeploymentUploadRequest {
  target?: DeploymentTarget;
  meta?: DeploymentMeta;
  /** Seconds until the URL stops accepting uploads. 60–900, default 900. */
  expiresIn?: number;
}

export interface DeploymentUploadResponse {
  uploadId: string;
  /** PUT a gzip tarball here with no Authorization header. Single use. */
  uploadUrl: string;
  expiresAt: string;
}

export type DeploymentUploadStatus = "pending" | "received" | "expired";

/** GET /v1/deployment-uploads/:id */
export interface DeploymentUploadStatusResponse {
  uploadId: string;
  status: DeploymentUploadStatus;
  deploymentId: string | null;
  expiresAt: string;
}

/** PUT <uploadUrl> */
export interface DeploymentUploadReceivedResponse {
  deploymentId: string;
}

export interface DeploymentLogLine {
  id: string;
  message: string;
  level: "INFO" | "WARNING" | "ERROR";
  createdAt: string;
}

export interface DeploymentLogsResponse {
  logs: DeploymentLogLine[];
}

/** One request the deployment served, with its function's first log line. */
export interface RuntimeLogRecord {
  /** Unique ID of the request. */
  requestId: string;
  /** HTTP method, such as `GET`. */
  method: string | null;
  /** Request path, without the query string. */
  path: string | null;
  /** Hostname the request was sent to. */
  host: string | null;
  /** HTTP status code of the response. */
  statusCode: number | null;
  /** Time to serve the request, in milliseconds. */
  durationMs: number | null;
  /** ISO timestamp of the latest event recorded for the request. */
  lastEventAt: string;
  /** The deployment that served the request. */
  deploymentId: string | null;
  /** Whether the response came from the cache, such as `HIT` or `MISS`. */
  cacheCdn: string | null;
  /** Whether a function ran for the request (false for static files and cache hits). */
  functionInvoked: boolean | null;
  /** The route of the function that ran, when one did. */
  functionRoute: string | null;
  /** How many log lines the function wrote for the request. */
  logCount: number | null;
  /** The first log line the function wrote, if any. */
  firstLogMessage: string | null;
  /** `ok`, or `error` when the function failed. */
  outcome: string | null;
}

export interface RuntimeLogsResponse {
  records: RuntimeLogRecord[];
}

/**
 * POST /v1/projects/:id/promote/:deploymentId and …/rollback/:deploymentId.
 * `deployment` is the one that serves (or will serve) production. Promoting a
 * preview rebuilds it with production env, so its id differs from the request.
 */
export interface TrafficResponse {
  deployment: Deployment;
  /** True when `deployment` is a new build that goes live once it's READY. */
  rebuilt: boolean;
}

// ---------------------------------------------------------------------------
// Files (content-addressed uploads)
// ---------------------------------------------------------------------------

export interface MissingFilesRequest {
  hashes: string[];
}

export interface MissingFilesResponse {
  missing: string[];
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

export type EnvTarget = "production" | "preview" | "development";

export interface EnvVar {
  id: string;
  key: string;
  target: EnvTarget[];
  /** Preview only: the branch it applies to; null for every branch. */
  gitBranch: string | null;
  comment: string | null;
  sensitive: boolean;
  /** Present when listed with `?decrypt=true` and the variable isn't sensitive. */
  value?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvListResponse {
  envs: EnvVar[];
}

/** POST /v1/projects/:id/env (`?upsert=true` replaces a variable with the same key and branch). */
export interface CreateEnvRequest {
  key: string;
  value: string;
  target: EnvTarget[];
  gitBranch?: string | null;
  comment?: string | null;
  sensitive?: boolean;
}

/** POST /v1/projects/:id/env also accepts an array, applied in one transaction. */
export type CreateEnvBody = CreateEnvRequest | CreateEnvRequest[];

export interface CreateEnvResponse {
  created: EnvVar[];
}

/** PATCH /v1/projects/:id/env/:envId */
export interface UpdateEnvRequest {
  key?: string;
  value?: string;
  target?: EnvTarget[];
  gitBranch?: string | null;
  comment?: string | null;
}

export interface EnvResponse {
  env: EnvVar;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export type DomainStatus = "pending_dns" | "provisioning_tls" | "live" | "error";

/** A hostname on a project. One response carries everything a UI needs. */
export interface ProjectDomain {
  name: string;
  projectId: string;
  status: DomainStatus;
  /** What to add at the DNS provider. Empty once live, and for names under a wildcard domain. */
  records: DnsRecord[];
  error: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface ProjectDomainListResponse {
  domains: ProjectDomain[];
}

export interface ProjectDomainResponse {
  domain: ProjectDomain;
}

/** POST /v1/projects/:id/domains */
export interface AddProjectDomainRequest {
  name: string;
  /**
   * Move the name here when it's on another project in the workspace. Without
   * it, that's a 409 `domain_in_project`. The domain keeps its CNAME target,
   * status and certificate, so DNS doesn't change.
   */
  move?: boolean;
}

/** A workspace wildcard domain (`*.example.app`) whose subdomains can be assigned to projects. */
export interface WildcardDomain {
  domain: string;
  dnsMode: "external" | "easel";
  status: DomainStatus;
  records: DnsRecord[];
  error: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface WildcardDomainListResponse {
  wildcardDomains: WildcardDomain[];
}

export interface WildcardDomainResponse {
  wildcardDomain: WildcardDomain;
}

/** POST /v1/wildcard-domains */
export interface AddWildcardDomainRequest {
  domain: string;
  dnsMode?: "external" | "easel";
}

/** The workspace's branded CNAME target (`domains.example.app`) that end users point at. */
export interface DomainTarget {
  host: string;
  status: "pending_dns" | "live" | "error";
  records: DnsRecord[];
  error: string | null;
  verifiedAt: string | null;
}

export interface DomainTargetResponse {
  domainTarget: DomainTarget | null;
}

/** PUT /v1/domain-target */
export interface SetDomainTargetRequest {
  host: string;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface ProjectUsage {
  projectId: string;
  requests: number;
  functionInvocations: number;
  functionDurationGbHours: number;
  dataTransferGb: number;
  buildMinutes: number;
  /** Every metered quantity, by meter id, in the meter's own unit. */
  meters: Record<string, number>;
}

/** GET /v1/usage?from=&to=&projectId= */
export interface UsageResponse {
  from: string;
  to: string;
  projects: ProjectUsage[];
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENT_TYPES = [
  "deployment.created",
  "deployment.succeeded",
  "deployment.error",
  "deployment.canceled",
  "deployment.promoted",
  "domain.updated",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface DeploymentEventPayload {
  projectId: string;
  deploymentId: string;
  target: DeploymentTarget;
  status: DeploymentStatus;
  url: string | null;
  meta: DeploymentMeta | null;
}

export interface DomainEventPayload {
  projectId: string | null;
  domain: string;
  status: DomainStatus | "removed" | "transferred";
}

export type WebhookEvent =
  | { id: string; type: Exclude<WebhookEventType, "domain.updated">; createdAt: string; payload: DeploymentEventPayload }
  | { id: string; type: "domain.updated"; createdAt: string; payload: DomainEventPayload };

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEventType[];
  /** Limit to these projects; empty for every project in the workspace. */
  projectIds: string[];
  createdAt: string;
}

export interface WebhookListResponse {
  webhooks: Webhook[];
}

/** POST /v1/webhooks */
export interface CreateWebhookRequest {
  url: string;
  events: WebhookEventType[];
  projectIds?: string[];
}

/** The signing secret is only ever returned here. */
export interface CreateWebhookResponse {
  webhook: Webhook;
  secret: string;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface Token {
  id: string;
  name: string;
  /** The first characters of the token, for recognising it. */
  start: string | null;
  permissions: PermissionMap;
  /** The projects it may act on; null for every project in the workspace. */
  projectIds: string[] | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface TokenListResponse {
  tokens: Token[];
}

/** POST /v1/tokens */
export interface CreateTokenRequest {
  name: string;
  permissions: PermissionMap;
  projectIds?: string[];
  /** Seconds until it expires. 60 to 1 year. Can't outlive the token that mints it. */
  expiresIn: number;
}

/** The secret is only ever returned here. */
export interface CreateTokenResponse {
  token: Token;
  secret: string;
}

// ---------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------

/** POST /v1/frameworks/detect */
export interface DetectFrameworkRequest {
  /** File paths relative to the app root, POSIX separators. */
  paths: string[];
  /** Contents of the files detection reads (`FRAMEWORK_DETECTION_CONTENT_PATHS`), each at most `FRAMEWORK_DETECTION_MAX_FILE_BYTES`. */
  files: Record<string, string>;
}

export interface DetectFrameworkResponse {
  framework: { slug: string; name: string } | null;
  buildCommand: string | null;
  installCommand: string | null;
  outputDirectory: string | null;
}
