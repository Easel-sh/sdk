/**
 * What an Easel API token may do. A token carries a subset of these; every
 * `/v1` route names the permissions it needs.
 */
export const PERMISSIONS = {
  projects: ["read", "create", "update", "delete"],
  deployments: ["read", "create", "cancel", "promote"],
  env: ["read", "write"],
  domains: ["read", "write"],
  usage: ["read"],
  webhooks: ["read", "write"],
  tokens: ["read", "write"],
  files: ["write"],
  /** Easel Sandboxes: `read` for gets and lists, `write` for the rest. */
  sandboxes: ["read", "write"],
  /** Schedules: `read` for gets and lists, `write` for the rest. */
  schedules: ["read", "write"],
} as const;

export type PermissionResource = keyof typeof PERMISSIONS;

export type PermissionMap = {
  [R in PermissionResource]?: ReadonlyArray<(typeof PERMISSIONS)[R][number]>;
};

/** Every permission, for workspace tokens (`easel login`, workspace token settings). */
export const ALL_PERMISSIONS: PermissionMap = PERMISSIONS;
