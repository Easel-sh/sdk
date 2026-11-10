/**
 * Webhook signatures. Every delivery carries
 *
 * - `x-easel-timestamp: <unix seconds>`
 * - `x-easel-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`
 *
 * keyed with the webhook's `whsec_…` secret. Signing the timestamp with the
 * body means a captured delivery can't be replayed later. Web Crypto only, so
 * it runs on Node, Bun, Deno and edge runtimes.
 */

export const WEBHOOK_SIGNATURE_HEADER = "x-easel-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-easel-timestamp";
/** How old (or how far in the future) a timestamp may be by default. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  let hex = "";
  for (const byte of signature) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The `x-easel-signature` value for `rawBody` sent at `timestamp` (unix seconds). */
export async function signWebhook(secret: string, rawBody: string, timestamp: number | string): Promise<string> {
  return `sha256=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyWebhookInput {
  /** The request body exactly as received, before any JSON parsing. */
  rawBody: string;
  /** The `x-easel-signature` header. */
  signature: string | null | undefined;
  /** The `x-easel-timestamp` header. */
  timestamp: string | number | null | undefined;
  /** The webhook's `whsec_…` secret. */
  secret: string;
  /** Reject timestamps further than this from now. Defaults to 300. */
  toleranceSeconds?: number;
}

/**
 * Whether a delivery is genuine: the signature matches the body and
 * timestamp, and the timestamp is within `toleranceSeconds` of now.
 */
export async function verifyWebhook({
  rawBody,
  signature,
  timestamp,
  secret,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
}: VerifyWebhookInput): Promise<boolean> {
  if (!signature || timestamp == null || timestamp === "") return false;
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - seconds) > toleranceSeconds) return false;

  const expected = await signWebhook(secret, rawBody, seconds);
  return timingSafeEqual(signature.trim().toLowerCase(), expected);
}
