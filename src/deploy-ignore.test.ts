import { describe, expect, it } from "vitest";
import { isAlwaysDropped } from "./deploy-ignore.js";

describe("isAlwaysDropped", () => {
  it("drops env files and version control at any depth", () => {
    for (const path of [".env", ".env.local", ".env.production", "apps/web/.env.local", ".git/config", "./.git/HEAD", "pkg/.hg/store", ".svn/entries"]) {
      expect(isAlwaysDropped(path), path).toBe(true);
    }
  });

  it("drops macOS metadata files at any depth", () => {
    for (const path of [".DS_Store", "public/.DS_Store", "._index.html", "app/routes/._api.health.tsx", "./._package.json", "dist/_app/._immutable"]) {
      expect(isAlwaysDropped(path), path).toBe(true);
    }
  });

  it("keeps everything else, including .env.example and build output", () => {
    for (const path of [".env.example", "apps/web/.env.example", "index.html", "dist/config.json", ".next/BUILD_ID", "environment.ts", "docs/.envrc-guide.md", "_app/immutable/start.js", "._dir/index.html", "assets/_index-Bm.js", "a._b.js"]) {
      expect(isAlwaysDropped(path), path).toBe(false);
    }
  });
});
