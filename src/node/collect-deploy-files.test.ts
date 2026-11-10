import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectDeployFiles, createSourceArchiveTgz } from "./collect-deploy-files.js";

describe("collectDeployFiles", () => {
  it("ignores node_modules and .git by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "easel-collect-"));
    try {
      await writeFile(join(root, "package.json"), '{"name":"app"}\n');
      await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
      await writeFile(join(root, "node_modules", "left-pad", "index.js"), "1");
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git", "config"), "x");
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "index.ts"), "export {}");

      const files = await collectDeployFiles({ root });
      const paths = files.map((f) => f.file);
      expect(paths).toContain("package.json");
      expect(paths).toContain("src/index.ts");
      expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
      expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores .env and .env.* by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "easel-collect-env-"));
    try {
      await writeFile(join(root, "package.json"), '{"name":"app"}\n');
      await writeFile(join(root, ".env"), "SECRET=1\n");
      await writeFile(join(root, ".env.production"), "SECRET=2\n");
      await writeFile(join(root, ".env.local"), "SECRET=3\n");
      await writeFile(join(root, ".env.example"), "SECRET=\n");

      const files = await collectDeployFiles({ root });
      const paths = files.map((f) => f.file);
      expect(paths).toContain("package.json");
      expect(paths).not.toContain(".env");
      expect(paths).not.toContain(".env.production");
      expect(paths).not.toContain(".env.local");
      expect(paths).not.toContain(".env.example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports .easelignore negation to re-include files", async () => {
    const root = await mkdtemp(join(tmpdir(), "easel-collect-neg-"));
    try {
      await writeFile(join(root, "package.json"), '{"name":"app"}\n');
      await writeFile(join(root, ".env.example"), "SECRET=\n");
      await writeFile(join(root, ".easelignore"), "!.env.example\n");

      const files = await collectDeployFiles({ root });
      const paths = files.map((f) => f.file);
      expect(paths).toContain(".env.example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops directories matched by a trailing-slash pattern in .easelignore", async () => {
    const root = await mkdtemp(join(tmpdir(), "easel-collect-dir-"));
    try {
      await writeFile(join(root, "index.html"), "<h1>hi</h1>");
      await mkdir(join(root, "coverage"), { recursive: true });
      await writeFile(join(root, "coverage", "lcov.info"), "x");
      await writeFile(join(root, ".easelignore"), "coverage/\n");

      const paths = (await collectDeployFiles({ root })).map((f) => f.file);
      expect(paths.sort()).toEqual([".easelignore", "index.html"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createSourceArchiveTgz", () => {
  it("refuses paths that escape the source root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easel-archive-"));
    try {
      const file = join(dir, "a.txt");
      await writeFile(file, "a");
      const escaping = [{ file: "../outside.txt", contentHash: "sha256:x", size: 1, mode: 0o100644, absolutePath: file }];
      await expect(createSourceArchiveTgz(escaping, join(dir, "out.tgz"))).rejects.toThrow(/outside the source root/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
