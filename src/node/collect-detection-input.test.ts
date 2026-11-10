import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDetectionInput } from "./collect-detection-input.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "easel-detect-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("collectDetectionInput", () => {
  it("lists files, skips build output and reads the root package.json", async () => {
    await writeFile(join(cwd, "package.json"), '{"name":"storefront"}');
    await mkdir(join(cwd, "app"));
    await writeFile(join(cwd, "app", "page.tsx"), "export default 1");
    await mkdir(join(cwd, "node_modules", "next"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "next", "package.json"), "{}");

    const { paths, files } = await collectDetectionInput(cwd);
    expect(paths.sort()).toEqual(["app/page.tsx", "package.json"]);
    expect(files).toEqual({ "package.json": '{"name":"storefront"}' });
  });

  it("reads the entry files backend detectors match by content, not other sources", async () => {
    await writeFile(join(cwd, "package.json"), '{"dependencies":{"express":"^4"}}');
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "index.ts"), "import express from 'express'");
    await writeFile(join(cwd, "src", "routes.ts"), "export {}");
    await writeFile(join(cwd, "server.js"), "x".repeat(64 * 1024 + 1));

    const { files } = await collectDetectionInput(cwd);
    expect(Object.keys(files).sort()).toEqual(["package.json", "src/index.ts"]);
    expect(files["src/index.ts"]).toBe("import express from 'express'");
  });
});
