import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { UserError } from "./errors.js";
import { GitError, GitRunner, type GitRunOptions } from "./git.js";
import { pathExists, safeProjectPath } from "./files.js";

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "conflicted";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  from?: string;
}

export interface StatusInfo {
  branch: string;
  head: string | null;
  remoteHead: string | null;
  /** Local edits that are not on Overleaf yet. */
  changes: FileChange[];
  conflicted: string[];
  mergeInProgress: boolean;
  /** Commits on Overleaf that have been fetched but not merged locally. */
  behind: number;
  /** Local commits not on Overleaf (normally 0: TexMex keeps edits uncommitted). */
  ahead: number;
}

export interface SyncResult {
  state: "cloned" | "up-to-date" | "updated" | "conflict";
  /** Files changed on Overleaf since the previous sync. */
  remoteChanges: FileChange[];
  conflicts: string[];
  pendingChanges: FileChange[];
}

export type PushResult =
  | { state: "pushed"; commit: string; files: FileChange[]; remoteChanges: FileChange[] }
  | { state: "nothing-to-push"; remoteChanges: FileChange[] }
  | { state: "conflict"; conflicts: string[]; remoteChanges: FileChange[] };

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  subject: string;
  files: FileChange[];
}

const LOCAL_WIP_MESSAGE = "TexMex: local changes (not yet pushed)";
const CONFLICT_MARKER = /^(<{7}|>{7})(?: |$)/m;

function kindFromLetter(letter: string): ChangeKind {
  switch (letter[0]) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

/** Parse `git diff --name-status -z` output. */
function parseNameStatus(out: string): FileChange[] {
  const parts = out.split("\0").filter((p) => p !== "");
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const kind = kindFromLetter(status);
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[i++];
      const to = parts[i++];
      changes.push({ path: to, kind, from });
    } else {
      changes.push({ path: parts[i++], kind });
    }
  }
  return changes;
}

export class Workspace {
  readonly dir: string;
  private branchName?: string;
  /** Epoch ms of the last successful fetch in this process (0 = never). */
  lastFetch = 0;

  constructor(
    private readonly config: Config,
    private readonly git: GitRunner,
    readonly projectId: string,
  ) {
    this.dir = path.join(config.workdir, "projects", projectId);
  }

  get remoteUrl(): string {
    return `${this.config.gitBaseUrl}/${this.projectId}`;
  }

  private g(args: string[], opts: GitRunOptions = {}) {
    return this.git.run(args, { cwd: this.dir, ...opts });
  }

  async isCloned(): Promise<boolean> {
    return pathExists(path.join(this.dir, ".git"));
  }

  async clone(): Promise<void> {
    if (await pathExists(this.dir)) {
      const entries = await fs.readdir(this.dir);
      if (entries.length > 0) {
        throw new UserError(
          `${this.dir} exists but is not a git working copy. Move or delete it, then try again.`,
        );
      }
      await fs.rmdir(this.dir);
    }
    await fs.mkdir(path.dirname(this.dir), { recursive: true });
    const tmp = `${this.dir}.partial-${process.pid}-${Date.now()}`;
    try {
      await this.git.run(["clone", "--quiet", "--", this.remoteUrl, tmp]);
      await fs.rename(tmp, this.dir);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw err;
    }
    this.lastFetch = Date.now();
  }

  async branch(): Promise<string> {
    if (this.branchName) return this.branchName;
    const sym = await this.g(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      allowFail: true,
    });
    let name = sym.code === 0 ? sym.stdout.trim().replace(/^origin\//, "") : "";
    if (!name) {
      for (const candidate of ["master", "main"]) {
        if (await this.revParse(`refs/remotes/origin/${candidate}`)) {
          name = candidate;
          break;
        }
      }
    }
    if (!name) {
      const cur = await this.g(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
      name = cur.stdout.trim() && cur.stdout.trim() !== "HEAD" ? cur.stdout.trim() : "master";
    }
    this.branchName = name;
    return name;
  }

  async remoteRef(): Promise<string> {
    return `refs/remotes/origin/${await this.branch()}`;
  }

  async revParse(ref: string): Promise<string | null> {
    const r = await this.g(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.g(["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true });
    return r.code === 0;
  }

  async fetch(): Promise<void> {
    await this.g(["fetch", "--quiet", "--prune", "origin"]);
    this.lastFetch = Date.now();
  }

  async mergeInProgress(): Promise<boolean> {
    return pathExists(path.join(this.dir, ".git", "MERGE_HEAD"));
  }

  async status(): Promise<StatusInfo> {
    const branch = await this.branch();
    const head = await this.revParse("HEAD");
    const remoteHead = await this.revParse(await this.remoteRef());

    if (await this.mergeInProgress()) {
      // HEAD is a temporary local commit here, so compare the working tree with
      // the Overleaf version being merged: that is what a push would send.
      const unresolved = await this.unresolvedConflicts();
      const changes = parseNameStatus(
        (await this.g(["diff", "--name-status", "-z", "-M", "MERGE_HEAD"])).stdout,
      ).map((c) => (unresolved.includes(c.path) ? { ...c, kind: "conflicted" as const } : c));
      const untracked = await this.g(["ls-files", "--others", "--exclude-standard", "-z"]);
      for (const file of untracked.stdout.split("\0").filter(Boolean)) {
        if (!changes.some((c) => c.path === file)) changes.push({ path: file, kind: "added" });
      }
      return { branch, head, remoteHead, changes, conflicted: unresolved, mergeInProgress: true, behind: 0, ahead: 0 };
    }

    const out = await this.g(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const parts = out.stdout.split("\0").filter((p) => p !== "");
    const changes: FileChange[] = [];
    const conflicted: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      const x = entry[0];
      const y = entry[1];
      const file = entry.slice(3);
      const xy = x + y;
      if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) {
        conflicted.push(file);
        changes.push({ path: file, kind: "conflicted" });
      } else if (x === "R" || x === "C") {
        const from = parts[++i];
        changes.push({ path: file, kind: x === "R" ? "renamed" : "added", from });
      } else if (xy === "??" || x === "A") {
        changes.push({ path: file, kind: "added" });
      } else if (x === "D" || y === "D") {
        changes.push({ path: file, kind: "deleted" });
      } else {
        changes.push({ path: file, kind: "modified" });
      }
    }
    let ahead = 0;
    let behind = 0;
    if (head && remoteHead && head !== remoteHead) {
      const counts = await this.g(["rev-list", "--left-right", "--count", `${head}...${remoteHead}`]);
      const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
      ahead = a || 0;
      behind = b || 0;
    }
    return { branch, head, remoteHead, changes, conflicted, mergeInProgress: false, behind, ahead };
  }

  private async isDirty(): Promise<boolean> {
    const out = await this.g(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    return out.stdout.length > 0;
  }

  private async diffNames(from: string, to: string): Promise<FileChange[]> {
    const out = await this.g(["diff", "--name-status", "-z", "-M", from, to]);
    return parseNameStatus(out.stdout);
  }

  /** Conflicted files that still contain conflict markers. */
  private async unresolvedConflicts(): Promise<string[]> {
    const out = await this.g(["diff", "--name-only", "-z", "--diff-filter=U"]);
    const files = out.stdout.split("\0").filter(Boolean);
    const unresolved: string[] = [];
    for (const file of files) {
      try {
        const text = await fs.readFile(path.join(this.dir, file), "utf8");
        if (CONFLICT_MARKER.test(text)) unresolved.push(file);
      } catch {
        // deleted while resolving: counts as resolved
      }
    }
    return unresolved;
  }

  private async commit(args: string[]): Promise<void> {
    await this.g(["commit", "--quiet", "--no-verify", ...args], { identity: true });
  }

  /**
   * Merge the fetched Overleaf branch into the working copy while keeping local
   * edits uncommitted. On conflict, leaves conflict markers in the files.
   */
  private async integrate(): Promise<{ conflicts: string[] }> {
    const remoteRef = await this.remoteRef();

    if (await this.mergeInProgress()) {
      const unresolved = await this.unresolvedConflicts();
      if (unresolved.length) return { conflicts: unresolved };
      await this.g(["add", "-A"]);
      await this.commit(["--no-edit"]);
    }

    const remote = await this.revParse(remoteRef);
    if (!remote) return { conflicts: [] };

    const beforeWip = await this.revParse("HEAD");
    if (await this.isDirty()) {
      await this.g(["add", "-A"]);
      await this.commit(["-m", LOCAL_WIP_MESSAGE]);
    }

    const head = await this.revParse("HEAD");
    if (head !== remote && !(await this.isAncestor(remote, "HEAD"))) {
      const merge = await this.g(["merge", "--no-edit", "--quiet", remoteRef], {
        allowFail: true,
        identity: true,
      });
      if (merge.code !== 0) {
        if (await this.mergeInProgress()) {
          const out = await this.g(["diff", "--name-only", "-z", "--diff-filter=U"]);
          return { conflicts: out.stdout.split("\0").filter(Boolean) };
        }
        // Put the local edits back into the working tree before reporting the failure.
        if (beforeWip && head !== beforeWip) await this.g(["reset", "--quiet", "--mixed", beforeWip]);
        throw new GitError(
          `Merging Overleaf changes failed:\n${(merge.stderr || merge.stdout).trim()}`,
          ["merge"],
          merge.code,
          merge.stdout,
          merge.stderr,
        );
      }
    }

    // Restore the invariant: HEAD == Overleaf's branch, local edits live in the working tree.
    await this.g(["reset", "--quiet", "--mixed", remoteRef]);
    return { conflicts: [] };
  }

  /**
   * TexMex never keeps local commits. If one was left behind (an interrupted
   * push, or someone committing in the working copy by hand), fold it back into
   * uncommitted changes so status/diff/push see it.
   */
  private async normalize(): Promise<void> {
    if (await this.mergeInProgress()) return;
    const head = await this.revParse("HEAD");
    const remote = await this.revParse(await this.remoteRef());
    if (!head || !remote || head === remote) return;
    const base = await this.g(["merge-base", head, remote], { allowFail: true });
    const mergeBase = base.code === 0 ? base.stdout.trim() : "";
    if (mergeBase && mergeBase !== head) await this.g(["reset", "--quiet", "--mixed", mergeBase]);
  }

  /** Clone if needed, fetch, and merge Overleaf's latest version with local edits. */
  async sync(): Promise<SyncResult> {
    if (!(await this.isCloned())) {
      await this.clone();
      return { state: "cloned", remoteChanges: [], conflicts: [], pendingChanges: [] };
    }
    const remoteRef = await this.remoteRef();
    const before = await this.revParse(remoteRef);
    await this.fetch();
    const after = await this.revParse(remoteRef);
    const remoteChanges = before && after && before !== after ? await this.diffNames(before, after) : [];
    const { conflicts } = await this.integrate();
    const status = await this.status();
    if (conflicts.length) {
      return { state: "conflict", remoteChanges, conflicts, pendingChanges: status.changes };
    }
    return {
      state: before === after ? "up-to-date" : "updated",
      remoteChanges,
      conflicts: [],
      pendingChanges: status.changes,
    };
  }

  /**
   * Cheap freshness check used before other tools: fetch and fast-forward when
   * that cannot disturb local edits. Returns human-readable notes.
   */
  async autoSync(): Promise<string[]> {
    const notes: string[] = [];
    if (!(await this.isCloned())) {
      await this.clone();
      notes.push(`Downloaded the project from Overleaf into ${this.dir}.`);
      return notes;
    }
    await this.normalize();
    const interval = this.config.autoSyncSeconds;
    if (interval <= 0 || Date.now() - this.lastFetch < interval * 1000) return notes;
    const remoteRef = await this.remoteRef();
    try {
      await this.fetch();
    } catch (err) {
      notes.push(`Could not reach Overleaf (${(err as Error).message.split("\n")[0]}); using the local copy.`);
      this.lastFetch = Date.now();
      return notes;
    }
    if (await this.mergeInProgress()) {
      notes.push("A merge with Overleaf changes has unresolved conflicts (see get_status).");
      return notes;
    }
    const head = await this.revParse("HEAD");
    const remote = await this.revParse(remoteRef);
    if (!remote || head === remote) return notes;
    if (head && (await this.isAncestor(head, remote))) {
      const changed = await this.diffNames(head, remote);
      const ff = await this.g(["merge", "--ff-only", "--quiet", remoteRef], { allowFail: true });
      if (ff.code === 0) {
        notes.push(
          `Pulled ${changed.length} updated file(s) from Overleaf: ${changed.map((c) => c.path).slice(0, 10).join(", ")}${changed.length > 10 ? ", …" : ""}.`,
        );
      } else {
        notes.push(
          "Overleaf has newer changes that touch files you edited locally; call sync_project to merge them.",
        );
      }
    } else {
      notes.push("Local history differs from Overleaf; call sync_project to merge.");
    }
    return notes;
  }

  async push(message: string): Promise<PushResult> {
    const msg = message.trim() || "Update from TexMex";
    let remoteChanges: FileChange[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const synced = await this.sync();
      remoteChanges = remoteChanges.concat(synced.remoteChanges);
      if (synced.state === "conflict") return { state: "conflict", conflicts: synced.conflicts, remoteChanges };

      const base = await this.revParse("HEAD");
      await this.g(["add", "-A"]);
      const staged = parseNameStatus((await this.g(["diff", "--cached", "--name-status", "-z", "-M"])).stdout);
      if (!staged.length) return { state: "nothing-to-push", remoteChanges };
      await this.commit(["-m", msg]);

      const branch = await this.branch();
      const pushed = await this.g(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], {
        allowFail: true,
      });
      if (pushed.code === 0) {
        const commit = (await this.revParse("HEAD")) ?? "";
        // Keep the remote-tracking ref in step even if git didn't update it.
        await this.g(["update-ref", await this.remoteRef(), commit]);
        this.lastFetch = Date.now();
        return { state: "pushed", commit, files: staged, remoteChanges };
      }

      // Undo the commit so the edits are pending again, then decide whether to retry.
      if (base) await this.g(["reset", "--quiet", "--mixed", base]);
      else await this.g(["update-ref", "-d", "HEAD"]);
      const output = `${pushed.stdout}\n${pushed.stderr}`;
      if (/fetch first|non-fast-forward|\[rejected\]/.test(output) && !/remote rejected/.test(output)) continue;
      throw new GitError(
        `Overleaf rejected the push:\n${output.trim()}`,
        ["push"],
        pushed.code,
        pushed.stdout,
        pushed.stderr,
      );
    }
    throw new UserError("The project kept changing on Overleaf while pushing. Wait a moment and try again.");
  }

  /** Discard local edits for the given paths, or everything (also aborts a conflicted merge). */
  async discard(paths: string[] | "all"): Promise<FileChange[]> {
    const before = (await this.status()).changes;
    if (paths === "all") {
      if (await this.mergeInProgress()) await this.g(["merge", "--abort"], { allowFail: true });
      const remoteRef = await this.remoteRef();
      const target = (await this.revParse(remoteRef)) ? remoteRef : "HEAD";
      await this.g(["reset", "--quiet", "--hard", target]);
      await this.g(["clean", "-fdq"]);
      return before;
    }
    if (await this.mergeInProgress()) {
      throw new UserError(
        "A merge with Overleaf changes is in progress. Resolve the conflict markers and sync/push, or discard all changes to abort the merge.",
      );
    }
    const rels: string[] = [];
    for (const p of paths) {
      const abs = await safeProjectPath(this.dir, p);
      rels.push(path.relative(this.dir, abs).split(path.sep).join("/"));
    }
    for (const rel of rels) {
      await this.g(["checkout", "HEAD", "--", rel], { allowFail: true });
      await this.g(["clean", "-fdq", "--", rel], { allowFail: true });
    }
    const matches = (c: FileChange) =>
      rels.some((r) => c.path === r || c.path.startsWith(`${r}/`) || c.from === r);
    return before.filter(matches);
  }

  async diff(opts: { paths?: string[]; since?: string; stat?: boolean }): Promise<string> {
    const rels: string[] = [];
    for (const p of opts.paths ?? []) {
      const abs = await safeProjectPath(this.dir, p);
      rels.push(path.relative(this.dir, abs).split(path.sep).join("/"));
    }
    // During a merge HEAD is a temporary local commit; diff against Overleaf's version instead.
    let base = (await this.mergeInProgress()) ? "MERGE_HEAD" : "HEAD";
    if (opts.since) {
      if (!/^[A-Za-z0-9_.~^/@{}-]+$/.test(opts.since) || opts.since.startsWith("-")) {
        throw new UserError(`Invalid revision "${opts.since}".`);
      }
      const resolved = await this.revParse(opts.since);
      if (!resolved) throw new UserError(`Unknown revision "${opts.since}". Use a commit hash from get_history.`);
      base = resolved;
    }
    const format = opts.stat ? ["--stat=120"] : [];
    const tracked = await this.g(["diff", "--no-color", "--no-ext-diff", "-M", ...format, base, "--", ...rels]);
    let text = tracked.stdout;

    // `git diff` ignores untracked files; show new files too.
    const untracked = await this.g(["ls-files", "--others", "--exclude-standard", "-z", "--", ...rels]);
    for (const file of untracked.stdout.split("\0").filter(Boolean)) {
      const d = await this.g(["diff", "--no-color", "--no-index", ...format, "--", "/dev/null", file], {
        allowFail: true,
      });
      text += d.stdout;
    }
    return text;
  }

  async log(limit: number, file?: string): Promise<CommitInfo[]> {
    const args = [
      "log",
      `-n${Math.max(1, Math.min(limit, 200))}`,
      "--date=iso-strict",
      "--format=%x1e%H%x1f%an%x1f%ad%x1f%s",
      "--name-status",
      "-z",
    ];
    const ref = (await this.revParse(await this.remoteRef())) ? await this.remoteRef() : "HEAD";
    args.push(ref);
    if (file) {
      const abs = await safeProjectPath(this.dir, file);
      args.push("--", path.relative(this.dir, abs).split(path.sep).join("/"));
    }
    const out = await this.g(args);
    const commits: CommitInfo[] = [];
    for (const chunk of out.stdout.split("\x1e")) {
      if (!chunk.trim()) continue;
      const nl = chunk.indexOf("\n");
      const header = nl >= 0 ? chunk.slice(0, nl) : chunk;
      const body = nl >= 0 ? chunk.slice(nl + 1) : "";
      const [hash, author, date, subject] = header.replace(/\0+$/, "").split("\x1f");
      commits.push({ hash, author, date, subject, files: parseNameStatus(body.replace(/^\0+/, "")) });
    }
    return commits;
  }
}
