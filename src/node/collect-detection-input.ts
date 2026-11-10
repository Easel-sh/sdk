import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { FRAMEWORK_DETECTION_CONTENT_PATHS, FRAMEWORK_DETECTION_MAX_FILE_BYTES } from "../framework-detection.js";

/** What `POST /v1/frameworks/detect` takes: file paths, and the contents of the files detection reads. */
export interface DetectionInput {
  /** Every file path (relative, POSIX) up to three folders deep. */
  paths: string[];
  /** Contents of the files in `FRAMEWORK_DETECTION_CONTENT_PATHS`, by path. */
  files: Record<string, string>;
}

/** Skipped during detection, along with every dot-directory (caches, VCS, build output). */
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
const DETECTION_MAX_DEPTH = 3;
const DETECTION_MAX_PATHS = 2_000;
const CONTENT_PATHS = new Set(["package.json", ...FRAMEWORK_DETECTION_CONTENT_PATHS]);

/**
 * Framework detection input for the app at `root`: its file paths, skipping
 * dependencies and build output, and the contents of the files detectors match
 * by content (`package.json`, backend entry files, Python and Rust manifests).
 * Send it to `POST /v1/frameworks/detect`.
 */
export async function collectDetectionInput(root: string): Promise<DetectionInput> {
  const paths: string[] = [];
  const files: Record<string, string> = {};

  async function walk(dir: string, depth: number): Promise<void> {
    if (paths.length >= DETECTION_MAX_PATHS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (paths.length >= DETECTION_MAX_PATHS) return;
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        const skip = entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name);
        if (!skip && depth < DETECTION_MAX_DEPTH) await walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        paths.push(rel);
        if (CONTENT_PATHS.has(rel) && (await stat(absolute)).size <= FRAMEWORK_DETECTION_MAX_FILE_BYTES) {
          files[rel] = await readFile(absolute, "utf8");
        }
      }
    }
  }

  await walk(root, 0);
  return { paths, files };
}
