import fs from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";

export interface FileEntry {
  /** POSIX-style path relative to the project root. */
  path: string;
  size: number;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Normalise a user-supplied project-relative path ("./a.tex", "/a.tex", "a\\b.tex"). */
export function normalizeRelPath(rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new UserError("A file path is required.");
  let p = rel.trim().replace(/\\/g, "/");
  p = p.replace(/^\.\/+/, "").replace(/^\/+/, "");
  const normalized = path.posix.normalize(p);
  return normalized === "." ? "" : normalized.replace(/\/+$/, "");
}

/**
 * Resolve a project-relative path to an absolute path inside the project,
 * refusing anything that escapes the project or touches .git.
 */
export function resolveInProject(root: string, rel: string, opts: { allowRoot?: boolean } = {}): string {
  const normalized = normalizeRelPath(rel);
  if (!normalized) {
    if (opts.allowRoot) return root;
    throw new UserError("Path must point to a file inside the project, not the project root.");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new UserError(`Path "${rel}" is outside the project.`);
  }
  const first = normalized.split("/")[0];
  if (first === ".git") throw new UserError("The .git directory cannot be accessed.");
  const abs = path.resolve(root, normalized);
  const relative = path.relative(root, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UserError(`Path "${rel}" is outside the project.`);
  }
  return abs;
}

/**
 * Guard against symlinks that point outside the project: resolve the deepest
 * existing ancestor of `abs` and make sure it is still inside `root`.
 */
export async function assertRealPathInside(root: string, abs: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const relative = path.relative(realRoot, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new UserError("Path resolves outside the project (symlink).");
      }
      return;
    } catch (err) {
      if (err instanceof UserError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
  }
}

export async function safeProjectPath(root: string, rel: string, opts: { allowRoot?: boolean } = {}): Promise<string> {
  const abs = resolveInProject(root, rel, opts);
  await assertRealPathInside(root, abs);
  return abs;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list files under `root` (optionally a sub-directory), skipping .git and symlinks. */
export async function walkFiles(root: string, subdir = "", limit = 20000): Promise<FileEntry[]> {
  const start = subdir ? resolveInProject(root, subdir) : root;
  const out: FileEntry[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && dir === start) {
        throw new UserError(`Directory "${subdir}" does not exist in the project.`);
      }
      if ((err as NodeJS.ErrnoException).code === "ENOTDIR" && dir === start) {
        const stat = await fs.stat(dir);
        out.push({ path: toPosix(path.relative(root, dir)), size: stat.size });
        return;
      }
      throw err;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (dir === root && entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        out.push({ path: toPosix(path.relative(root, abs)), size: stat.size });
      }
    }
  }
  await visit(start);
  return out;
}

export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

const TEXT_EXTENSIONS = new Set([
  ".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".dbx", ".lbx", ".txt", ".md", ".ltx",
  ".dtx", ".ins", ".cfg", ".def", ".clo", ".fd", ".tikz", ".pgf", ".csv", ".tsv", ".dat", ".json",
  ".yaml", ".yml", ".xml", ".svg", ".py", ".r", ".m", ".lua", ".sh", ".latexmkrc", ".bbl", ".rnw",
  ".gitignore", ".cff", ".html", ".css", ".js", ".ts", ".toml", ".ini", ".asy", ".gnuplot", ".gp",
]);

export function looksLikeTextPath(p: string): boolean {
  const base = path.posix.basename(p).toLowerCase();
  if (base === "latexmkrc" || base === ".latexmkrc" || base === "makefile" || base === "readme") return true;
  return TEXT_EXTENSIONS.has(path.posix.extname(base));
}

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Convert a simple glob (supports **, *, ?, {a,b}) to a RegExp matched against POSIX relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  // A pattern without a slash matches at any depth, like .gitignore.
  if (!g.includes("/")) g = `**/${g}`;
  let re = "";
  let i = 0;
  let inBrace = false;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 3 : 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      inBrace = true;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (c === "," && inBrace) {
      re += "|";
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
    i++;
  }
  return new RegExp(`^${re}$`, "i");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
