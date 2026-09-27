import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { UserError } from "./errors.js";
import { GitError, type GitRunner } from "./git.js";
import type { OverleafWeb, TreeFolder } from "./overleafWeb.js";

/**
 * How a working copy talks to Overleaf. Both transports maintain the same
 * contract: `refs/remotes/origin/<branch>` is the latest known Overleaf version.
 */
export interface Transport {
  readonly kind: "git" | "web";
  /** Create a working copy in `dir` with Overleaf's current version checked out. */
  create(dir: string): Promise<void>;
  /** Update `refs/remotes/origin/<branch>` to Overleaf's current version. */
  fetch(dir: string, branch: string): Promise<void>;
  /**
   * Publish commit `head`, whose parent `base` is Overleaf's current version.
   * "rejected" means Overleaf changed in the meantime (sync and try again).
   */
  publish(dir: string, branch: string, base: string, head: string): Promise<"ok" | "rejected">;
}

/** Overleaf's Git bridge (git.overleaf.com). Needs a Git token (paid plans / Server Pro). */
export class GitTransport implements Transport {
  readonly kind = "git";

  constructor(
    private readonly git: GitRunner,
    private readonly remoteUrl: string,
  ) {}

  async create(dir: string): Promise<void> {
    await this.git.run(["clone", "--quiet", "--", this.remoteUrl, dir]);
  }

  async fetch(dir: string): Promise<void> {
    await this.git.run(["fetch", "--quiet", "--prune", "origin"], { cwd: dir });
  }

  async publish(dir: string, branch: string): Promise<"ok" | "rejected"> {
    const pushed = await this.git.run(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], {
      cwd: dir,
      allowFail: true,
    });
    if (pushed.code === 0) return "ok";
    const output = `${pushed.stdout}\n${pushed.stderr}`;
    if (/fetch first|non-fast-forward|\[rejected\]/.test(output) && !/remote rejected/.test(output)) return "rejected";
    throw new GitError(`Overleaf rejected the push:\n${output.trim()}`, ["push"], pushed.code, pushed.stdout, pushed.stderr);
  }
}

/** Extract a zip into a map of safe, project-relative POSIX paths. */
export function extractZip(buf: Uint8Array): Map<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf);
  } catch (err) {
    throw new UserError(`Overleaf sent an unreadable zip file: ${(err as Error).message}`);
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const normalized = path.posix.normalize(name.replace(/\\/g, "/")).replace(/^\/+/, "");
    const parts = normalized.split("/");
    if (!normalized || normalized === "." || parts.includes("..") || parts[0] === ".git") continue;
    files.set(normalized, data);
  }
  return files;
}

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Overleaf",
  GIT_AUTHOR_EMAIL: "overleaf@texmex.invalid",
  GIT_COMMITTER_NAME: "Overleaf",
  GIT_COMMITTER_EMAIL: "overleaf@texmex.invalid",
};

interface TreeEntry {
  type: "doc" | "file" | "folder";
  id: string;
}

function indexTree(root: TreeFolder): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (folder: TreeFolder, prefix: string) => {
    for (const d of folder.docs ?? []) out.set(prefix + d.name, { type: "doc", id: d._id });
    for (const f of folder.fileRefs ?? []) out.set(prefix + f.name, { type: "file", id: f._id });
    for (const sub of folder.folders ?? []) {
      out.set(prefix + sub.name, { type: "folder", id: sub._id });
      walk(sub, `${prefix}${sub.name}/`);
    }
  };
  walk(root, "");
  return out;
}

/**
 * Sync through the Overleaf editor's own endpoints using the session cookie.
 * Works on free accounts. Every download becomes a "snapshot" commit, so the
 * usual merge logic applies; publishing uploads changed files and deletes
 * removed ones.
 */
export class WebTransport implements Transport {
  readonly kind = "web";

  constructor(
    private readonly git: GitRunner,
    private readonly web: OverleafWeb,
    private readonly projectId: string,
  ) {}

  async create(dir: string): Promise<void> {
    await this.git.run(["init", "--quiet", "-b", "master", dir]);
    await this.git.run(["config", "texmex.transport", "web"], { cwd: dir });
    await this.fetch(dir, "master");
    await this.git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"], { cwd: dir });
    await this.git.run(["checkout", "--quiet", "-B", "master", "refs/remotes/origin/master"], { cwd: dir });
  }

  async fetch(dir: string, branch: string): Promise<void> {
    const files = extractZip(await this.web.downloadZip(this.projectId));
    const gitDir = path.join(dir, ".git");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "texmex-snapshot-"));
    const index = path.join(gitDir, "texmex-snapshot.index");
    try {
      for (const [rel, data] of files) {
        const abs = path.join(tmp, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, data);
      }
      await fs.rm(index, { force: true });
      const opts = { cwd: tmp, env: { GIT_INDEX_FILE: index } };
      // -f: record files Overleaf has even if a .gitignore in the project would skip them.
      await this.git.run(["--git-dir", gitDir, "--work-tree", tmp, "add", "-A", "-f", "."], opts);
      const tree = (await this.git.run(["--git-dir", gitDir, "write-tree"], opts)).stdout.trim();

      const ref = `refs/remotes/origin/${branch}`;
      const parent = await this.git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir, allowFail: true });
      const parentId = parent.code === 0 ? parent.stdout.trim() : "";
      if (parentId) {
        const parentTree = (await this.git.run(["rev-parse", `${parentId}^{tree}`], { cwd: dir })).stdout.trim();
        if (parentTree === tree) return;
      }
      const commit = (
        await this.git.run(
          ["commit-tree", tree, ...(parentId ? ["-p", parentId] : []), "-m", "Version on Overleaf (downloaded by TexMex)"],
          { cwd: dir, env: SNAPSHOT_IDENTITY },
        )
      ).stdout.trim();
      await this.git.run(["update-ref", ref, commit], { cwd: dir });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(index, { force: true });
    }
  }

  async publish(dir: string, _branch: string, base: string, head: string): Promise<"ok" | "rejected"> {
    const diff = await this.git.run(["diff", "--name-status", "-z", "--no-renames", base, head], { cwd: dir });
    const parts = diff.stdout.split("\0").filter(Boolean);
    const uploads: string[] = [];
    const deletes: string[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      (parts[i] === "D" ? deletes : uploads).push(parts[i + 1]);
    }
    if (!uploads.length && !deletes.length) return "ok";

    const joined = await this.web.joinProject(this.projectId);
    const root = joined.project.rootFolder[0];
    if (joined.permissionsLevel && !["owner", "readAndWrite"].includes(joined.permissionsLevel)) {
      throw new UserError(`Your Overleaf account can only view this project (${joined.permissionsLevel}), so changes cannot be pushed.`);
    }
    const entities = indexTree(root);

    const done: string[] = [];
    const fail = (err: unknown, what: string) => {
      const doneText = done.length ? ` Already applied on Overleaf: ${done.join(", ")}.` : "";
      throw new UserError(`${(err as Error).message} (while ${what}).${doneText} Run sync_project, then push again.`);
    };

    // Uploads replace existing files by name, so edits keep the doc's history.
    for (const rel of uploads) {
      const content = await fs.readFile(path.join(dir, rel));
      try {
        await this.web.uploadFile(this.projectId, root._id, rel, content);
      } catch (err) {
        fail(err, `uploading ${rel}`);
      }
      done.push(rel);
    }

    for (const rel of deletes) {
      const entity = entities.get(rel);
      if (!entity || entity.type === "folder") continue; // already gone on Overleaf
      try {
        await this.web.deleteEntity(this.projectId, entity.type, entity.id);
      } catch (err) {
        fail(err, `deleting ${rel}`);
      }
      done.push(`deleted ${rel}`);
    }

    // Git has no empty folders: remove Overleaf folders whose files were all
    // deleted — unless the new version still has files there (e.g. just uploaded).
    const deleted = new Set(deletes);
    const kept = (await this.git.run(["ls-tree", "-r", "--name-only", "-z", head], { cwd: dir })).stdout
      .split("\0")
      .filter(Boolean);
    const removedFolders: string[] = [];
    const folders = [...entities].filter(([, e]) => e.type === "folder").sort(([a], [b]) => a.split("/").length - b.split("/").length);
    for (const [folderPath, entity] of folders) {
      if (removedFolders.some((f) => folderPath.startsWith(`${f}/`))) continue;
      const contents = [...entities].filter(([p, e]) => e.type !== "folder" && p.startsWith(`${folderPath}/`)).map(([p]) => p);
      const stillUsed = kept.some((p) => p.startsWith(`${folderPath}/`));
      if (!stillUsed && contents.length && contents.every((p) => deleted.has(p))) {
        try {
          await this.web.deleteEntity(this.projectId, "folder", entity.id);
          removedFolders.push(folderPath);
        } catch {
          // An empty folder left behind is harmless.
        }
      }
    }
    return "ok";
  }
}
