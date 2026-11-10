/**
 * Paths clients leave out of a deployment, in .gitignore syntax: VCS and tool
 * directories, build caches, and every `.env` / `.env.*` file. A project's
 * `.easelignore` adds to them.
 */
export const DEFAULT_DEPLOY_IGNORE: readonly string[] = [
  ".hg",
  ".git",
  ".gitmodules",
  ".svn",
  ".cache",
  ".next",
  ".easel",
  ".npmignore",
  ".dockerignore",
  ".gitignore",
  ".DS_Store",
  ".venv",
  "node_modules",
  "__pycache__",
  "venv",
  "CVS",
  "npm-debug.log",
  "config.gypi",
  ".env",
  ".env.*",
];

/** Ignore files read from the source root, in order. */
export const DEPLOY_IGNORE_FILES: readonly string[] = [".easelignore"];

/**
 * Whether Easel drops `path` from any source it receives, however it was sent.
 * Narrower than {@link DEFAULT_DEPLOY_IGNORE}: only secrets, version control,
 * and macOS metadata files, so a build output directory or a committed
 * `.next` still deploys. `.env.example` is kept. `path` is POSIX, relative to
 * the source root.
 *
 * macOS metadata is `.DS_Store` and AppleDouble `._<name>` files, which macOS
 * `tar` writes for extended attributes unless `COPYFILE_DISABLE` is set. Linux
 * `tar` extracts them as ordinary files, so frameworks with file-based routing
 * would build them as routes (`routes/._api.health.tsx`) and serve them.
 */
export function isAlwaysDropped(path: string): boolean {
  const segments = path.replace(/^\.?\/+/, "").split("/");
  const name = segments[segments.length - 1] ?? "";
  if (name === ".DS_Store" || name.startsWith("._")) return true;
  return segments.some((segment) => {
    if (segment === ".git" || segment === ".hg" || segment === ".svn") return true;
    if (segment === ".env.example") return false;
    return segment === ".env" || segment.startsWith(".env.");
  });
}
