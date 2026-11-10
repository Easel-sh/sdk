import { describe, expect, it, vi } from "vitest";
import {
  chooseFilesPath,
  createClient,
  DeploymentWaitTimeoutError,
  INLINE_FILES_MAX_BYTES,
  sandboxUploadScript,
} from "./client.js";
import { EaselApiError } from "./http.js";
import { signWebhook } from "./webhook-signature.js";
import type { Deployment } from "./types.js";

type Call = { url: URL; init: RequestInit };

function mockFetch(responder: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deployment(status: Deployment["status"], id = "dpl_1"): Deployment {
  return {
    id,
    projectId: "prj_1",
    source: "CLI",
    target: "production",
    status,
    queuedAt: null,
    buildingAt: null,
    readyAt: null,
    errorAt: null,
    cancelledAt: null,
    primaryUrl: null,
    gitSource: null,
    meta: null,
    aliases: [],
  };
}

const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

describe("createClient", () => {
  it("sends the token, user agent and JSON body to /api/v1 paths", async () => {
    const { fetch, calls } = mockFetch(() => json({ project: { id: "prj_1", name: "app" } }, 201));
    const client = createClient({ token: "easel_t", baseUrl: "https://easel.test/", fetch, userAgent: "test/1" });
    await client.projects.create({ name: "app" });
    expect(calls[0]!.url.toString()).toBe("https://easel.test/api/v1/projects");
    expect(header(calls[0]!, "authorization")).toBe("Bearer easel_t");
    expect(header(calls[0]!, "user-agent")).toBe("test/1");
    expect(header(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "app" });
  });

  it("maps error bodies onto EaselApiError", async () => {
    const records = [{ type: "TXT", name: "_easel.acme.com", value: "easel-verify=x" }];
    const { fetch } = mockFetch(() => json({ error: "In use", code: "domain_in_use", records }, 409));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    const error = await client.domains.add("prj_1", { name: "acme.com" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EaselApiError);
    expect(error).toMatchObject({ status: 409, code: "domain_in_use", records, message: "In use" });
  });

  it("retries 429s and 5xx on GETs", async () => {
    const { fetch, calls } = mockFetch((_call, index) =>
      index === 0 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : index === 1 ? new Response("", { status: 502 }) : json({ projects: [] }),
    );
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    vi.useFakeTimers();
    const pending = client.projects.list();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    vi.useRealTimers();
    expect(calls).toHaveLength(3);
  });

  it("doesn't retry a 5xx POST without an idempotency key", async () => {
    const { fetch, calls } = mockFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    await expect(client.request("POST", "/v1/whatever", { json: {} })).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });
});

describe("deployments.create", () => {
  it("sends small file sets inline with an idempotency key", async () => {
    const { fetch, calls } = mockFetch(() => json({ deployment: deployment("QUEUED") }, 202));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    await client.deployments.create({
      project: "trip-planner",
      target: "production",
      meta: { appVersion: "7" },
      files: [
        { file: "index.html", data: "<h1>hi</h1>" },
        { file: "logo.png", data: new Uint8Array([1, 2, 3]) },
        { file: "build.sh", data: "#!/bin/sh\n", mode: 0o755 },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/v1/projects/trip-planner/deployments");
    expect(header(calls[0]!, "idempotency-key")).toBeTruthy();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      target: "production",
      meta: { appVersion: "7" },
      // Permission bits become full regular-file modes, as on the dedup path.
      inlineFiles: [
        { file: "index.html", data: "<h1>hi</h1>", encoding: "utf-8", mode: 0o100644 },
        { file: "logo.png", data: "AQID", encoding: "base64", mode: 0o100644 },
        { file: "build.sh", data: "#!/bin/sh\n", encoding: "utf-8", mode: 0o100755 },
      ],
    });
  });

  it("uploads only missing files for large file sets", async () => {
    const big = new Uint8Array(INLINE_FILES_MAX_BYTES + 1).fill(7);
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.pathname.endsWith("/files/missing")) {
        const { hashes } = JSON.parse(String(call.init.body)) as { hashes: string[] };
        return json({ missing: [hashes[0]] });
      }
      if (call.url.pathname.endsWith("/files")) return new Response(null, { status: 204 });
      return json({ deployment: deployment("QUEUED") }, 202);
    });
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    await client.deployments.create({
      project: "p",
      files: [
        { file: "big.bin", data: big },
        { file: "small.txt", data: "x" },
      ],
    });
    const paths = calls.map((call) => call.url.pathname);
    expect(paths).toEqual(["/api/v1/files/missing", "/api/v1/files", "/api/v1/projects/p/deployments"]);
    expect(header(calls[1]!, "idempotency-key")).toMatch(/^sha256:[0-9a-f]{64}$/);
    const body = JSON.parse(String(calls[2]!.init.body)) as { files: { file: string; contentHash: string; mode: number }[] };
    expect(body.files.map((file) => file.file)).toEqual(["big.bin", "small.txt"]);
    expect(body.files[0]!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.files[0]!.mode).toBe(0o100644);
  });

  it("streams an archive with target and meta", async () => {
    const { fetch, calls } = mockFetch(() => json({ deployment: deployment("QUEUED") }, 202));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    await client.deployments.create({
      project: "p",
      target: "production",
      meta: { a: "b" },
      prebuilt: true,
      gitMetadata: { branch: "main" },
      archive: new Uint8Array([31, 139]),
    });
    expect(calls[0]!.url.searchParams.get("target")).toBe("production");
    expect(calls[0]!.url.searchParams.get("prebuilt")).toBe("true");
    expect(header(calls[0]!, "x-easel-git")).toBe('{"branch":"main"}');
    expect(header(calls[0]!, "content-type")).toBe("application/gzip");
    expect(header(calls[0]!, "x-easel-meta")).toBe('{"a":"b"}');
  });

  it("requires exactly one source", async () => {
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch: mockFetch(() => json({})).fetch });
    await expect(client.deployments.create({ project: "p" })).rejects.toThrow(/exactly one/);
  });
});

describe("chooseFilesPath", () => {
  it("switches to dedup above the inline limit", () => {
    expect(chooseFilesPath([{ file: "a", data: "x" }])).toBe("inline");
    expect(chooseFilesPath([{ file: "a", data: new Uint8Array(INLINE_FILES_MAX_BYTES + 1) }])).toBe("dedup");
  });
});

describe("deployments.wait", () => {
  it("reports each status once and returns the terminal deployment", async () => {
    const statuses: Deployment["status"][] = ["QUEUED", "QUEUED", "BUILDING", "READY"];
    const { fetch } = mockFetch((_call, index) => json({ deployment: deployment(statuses[index]!) }));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    const seen: string[] = [];
    const result = await client.deployments.wait("dpl_1", { intervalMs: 1, onStatus: (d) => seen.push(d.status) });
    expect(result.status).toBe("READY");
    expect(seen).toEqual(["QUEUED", "BUILDING", "READY"]);
  });

  it("times out with the last deployment", async () => {
    const { fetch } = mockFetch(() => json({ deployment: deployment("BUILDING") }));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    const error = await client.deployments.wait("dpl_1", { intervalMs: 1, timeoutMs: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeploymentWaitTimeoutError);
    expect((error as DeploymentWaitTimeoutError).deployment.status).toBe("BUILDING");
  });

  it("rejects at once with an already-aborted signal", async () => {
    const { fetch, calls } = mockFetch(() => json({ deployment: deployment("BUILDING") }));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(client.deployments.wait("dpl_1", { signal: controller.signal })).rejects.toThrow("stop");
    expect(calls.every((call) => call.init.signal === controller.signal)).toBe(true);
  });

  it("stops polling when the signal aborts mid-wait", async () => {
    const { fetch } = mockFetch(() => json({ deployment: deployment("BUILDING") }));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    const controller = new AbortController();
    const pending = client.deployments.wait("dpl_1", { intervalMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 5);
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("projects.ensure", () => {
  it("returns an existing project without creating one", async () => {
    const { fetch, calls } = mockFetch(() => json({ project: { id: "prj_1", name: "app" } }));
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    await expect(client.projects.ensure("app")).resolves.toMatchObject({ id: "prj_1" });
    expect(calls).toHaveLength(1);
  });

  it("creates the project when it doesn't exist", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.init.method === "POST" ? json({ project: { id: "prj_2", name: "app" } }, 201) : json({ error: "Project not found" }, 404),
    );
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    await expect(client.projects.ensure("app", { framework: "vite" })).resolves.toMatchObject({ id: "prj_2" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ name: "app", framework: "vite" });
  });

  it("retries the create after a 5xx with the same idempotency key", async () => {
    let posts = 0;
    const { fetch, calls } = mockFetch((call) => {
      if (call.init.method !== "POST") return json({ error: "Project not found" }, 404);
      posts += 1;
      return posts === 1 ? new Response("", { status: 502 }) : json({ project: { id: "prj_2", name: "app" } }, 201);
    });
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch });
    vi.useFakeTimers();
    const pending = client.projects.ensure("app");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "prj_2" });
    vi.useRealTimers();
    const keys = calls.filter((call) => call.init.method === "POST").map((call) => header(call, "idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("webhooks.verify", () => {
  it("returns the event for a genuine delivery and rejects a tampered one", async () => {
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch: mockFetch(() => json({})).fetch });
    const body = JSON.stringify({ id: "evt_1", type: "deployment.succeeded", createdAt: "2026-10-17T00:00:00Z", payload: {} });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signWebhook("whsec_test", body, timestamp);
    const headers = new Headers({ "x-easel-signature": signature, "x-easel-timestamp": String(timestamp) });
    await expect(client.webhooks.verify(body, headers, "whsec_test")).resolves.toMatchObject({ id: "evt_1" });
    await expect(client.webhooks.verify(`${body} `, headers, "whsec_test")).rejects.toThrow(/signature/);
  });

  it("reads plain-object headers case-insensitively", async () => {
    const client = createClient({ token: "t", baseUrl: "https://easel.test", fetch: mockFetch(() => json({})).fetch });
    const body = JSON.stringify({ id: "evt_2", type: "deployment.succeeded", createdAt: "2026-10-17T00:00:00Z", payload: {} });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signWebhook("whsec_test", body, timestamp);
    const headers = { "X-Easel-Signature": signature, "X-Easel-Timestamp": String(timestamp) };
    await expect(client.webhooks.verify(body, headers, "whsec_test")).resolves.toMatchObject({ id: "evt_2" });
  });
});

describe("sandboxUploadScript", () => {
  it("tars the working directory and PUTs it without a token", () => {
    const script = sandboxUploadScript("https://easel.test/upload/abc", { cwd: "/workspace/app" });
    expect(script).toBe(
      "cd '/workspace/app' && tar czf - --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='.env.*' . | curl -sSf -X PUT -H 'Content-Type: application/gzip' -T - 'https://easel.test/upload/abc'",
    );
    expect(script).not.toMatch(/Authorization|easel_/);
  });

  it("quotes single quotes safely", () => {
    expect(sandboxUploadScript("https://x/u/a'b")).toContain(`'https://x/u/a'\\''b'`);
  });
});
