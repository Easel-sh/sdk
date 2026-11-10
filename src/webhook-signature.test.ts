import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "./webhook-signature.js";

const secret = "whsec_test_secret";
const body = JSON.stringify({ id: "evt_1", type: "deployment.succeeded" });
const now = () => Math.floor(Date.now() / 1000);

describe("signWebhook", () => {
  it("is an HMAC-SHA256 of `<timestamp>.<body>`", async () => {
    const expected = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");
    expect(await signWebhook(secret, body, 1700000000)).toBe(`sha256=${expected}`);
  });
});

describe("verifyWebhook", () => {
  it("accepts a fresh, matching signature", async () => {
    const timestamp = now();
    const signature = await signWebhook(secret, body, timestamp);
    expect(await verifyWebhook({ rawBody: body, signature, timestamp: String(timestamp), secret })).toBe(true);
  });

  it("rejects a different body, secret or timestamp", async () => {
    const timestamp = now();
    const signature = await signWebhook(secret, body, timestamp);
    expect(await verifyWebhook({ rawBody: `${body} `, signature, timestamp, secret })).toBe(false);
    expect(await verifyWebhook({ rawBody: body, signature, timestamp, secret: "whsec_other" })).toBe(false);
    expect(await verifyWebhook({ rawBody: body, signature, timestamp: timestamp - 1, secret })).toBe(false);
  });

  it("rejects stale and future timestamps", async () => {
    const stale = now() - 301;
    expect(
      await verifyWebhook({ rawBody: body, signature: await signWebhook(secret, body, stale), timestamp: stale, secret }),
    ).toBe(false);
    const future = now() + 301;
    expect(
      await verifyWebhook({ rawBody: body, signature: await signWebhook(secret, body, future), timestamp: future, secret }),
    ).toBe(false);
    expect(
      await verifyWebhook({
        rawBody: body,
        signature: await signWebhook(secret, body, stale),
        timestamp: stale,
        secret,
        toleranceSeconds: 600,
      }),
    ).toBe(true);
  });

  it("rejects missing or malformed headers", async () => {
    const timestamp = now();
    expect(await verifyWebhook({ rawBody: body, signature: null, timestamp, secret })).toBe(false);
    expect(await verifyWebhook({ rawBody: body, signature: "sha256=abc", timestamp: null, secret })).toBe(false);
    expect(await verifyWebhook({ rawBody: body, signature: "sha256=abc", timestamp: "soon", secret })).toBe(false);
    expect(await verifyWebhook({ rawBody: body, signature: "sha256=abc", timestamp, secret })).toBe(false);
  });
});
