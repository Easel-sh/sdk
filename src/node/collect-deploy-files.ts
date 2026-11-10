import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { DEFAULT_DEPLOY_IGNORE, DEPLOY_IGNORE_FILES } from "../deploy-ignore.js";

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;

export type CollectedDeployFile = {
  /** Path relative to root, POSIX style, no leading slash. */
  file: string;
  /** `sha256:<hex>` for files; empty for directories. */
  contentHash: string;
  size: number;
  mode: number;
  absolutePath: string;
};

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function loadIgnorePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  for (const name of DEPLOY_IGNORE_FILES) {
    try {
      const raw = await readFile(join(root, name), "utf8");
      patterns.push(...raw.split("\n"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return patterns;
}

function buildIgnoreFilter(filePatterns: string[]): (relPosix: string) => boolean {
  const ig = ignore();
  ig.add([...DEFAULT_DEPLOY_IGNORE]);
  ig.add(filePatterns);
  return (relPosix) => Boolean(relPosix) && relPosix !== "." && ig.ignores(relPosix);
}

/**
 * Every file and directory under `root` that a deployment includes: the
 * default ignore list and `.easelignore` are applied.
 */
export async function collectDeployFiles(opts: { root: string }): Promise<CollectedDeployFile[]> {
  const { root } = opts;
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`Deploy root is not a directory: ${root}`);
  }

  const isIgnored = buildIgnoreFilter(await loadIgnorePatterns(root));
  const out: CollectedDeployFile[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (isIgnored(entry.isDirectory() ? `${rel}/` : rel)) continue;

      if (entry.isDirectory()) {
        out.push({ file: rel, contentHash: "", size: 0, mode: DIR_MODE, absolutePath: abs });
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const bytes = await readFile(abs);
      const { mode } = await stat(abs);
      out.push({
        file: rel,
        contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.length,
        mode: FILE_MODE | (mode & 0o777),
        absolutePath: abs,
      });
    }
  }

  await walk(root);

  if (!out.some((file) => file.contentHash)) {
    throw new Error("No files to deploy");
  }
  return out;
}

/** Pack collected files into a gzip tarball at `destPath`. Needs `tar` on the PATH. */
export async function createSourceArchiveTgz(
  files: CollectedDeployFile[],
  destPath: string,
): Promise<{ contentHash: string; size: number }> {
  const staging = await mkdtemp(join(tmpdir(), "easel-deploy-"));
  try {
    for (const file of files) {
      const target = resolve(staging, file.file);
      const rel = relative(staging, target);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Refusing to archive a path outside the source root: ${file.file}`);
      }
      if (!file.contentHash) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(file.absolutePath), { mode: file.mode & 0o777 });
    }

    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("tar", ["-czf", destPath, "-C", staging, "."], {
        stdio: "ignore",
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`tar exited with code ${code}`));
      });
    });

    const archive = await readFile(destPath);
    return { contentHash: `sha256:${createHash("sha256").update(archive).digest("hex")}`, size: archive.length };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
