import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { commandExists, compileLocal, compileOnOverleaf, formatCompileOutcome, type Engine } from "./compile.js";
import { hasCookie, type Config } from "./config.js";
import { TexMex, type ProjectRef } from "./context.js";
import { UserError, errorMessage } from "./errors.js";
import {
  IMAGE_MIME,
  formatBytes,
  globToRegExp,
  isProbablyBinary,
  pathExists,
  safeProjectPath,
  toPosix,
  walkFiles,
} from "./files.js";
import { analyzeProject, detectMainFile, findIssues } from "./outline.js";
import { VERSION } from "./version.js";
import type { FileChange, PushResult, SyncResult } from "./workspace.js";

const INSTRUCTIONS = `TexMex connects you to the user's Overleaf LaTeX projects.

Typical workflow:
1. list_projects (or pass an Overleaf project URL/ID/name directly as \`project\`).
2. get_outline / list_files / search_project / read_file to understand the document.
3. edit_file (preferred for targeted changes) or write_file to change files.
4. compile to check for LaTeX errors; get_compile_log for the raw log.
5. get_diff to review, then push_changes to publish to Overleaf.

Important:
- Edits are made in a local Git working copy and are NOT visible on Overleaf until push_changes succeeds.
- Pushing changes what collaborators see. Unless the user has already asked you to push, show them a summary (get_diff) and ask before calling push_changes.
- Collaborators may edit on Overleaf at the same time. sync_project merges their work with your pending edits. If there is a conflict, the affected files contain <<<<<<< / ======= / >>>>>>> markers: edit them to the intended text, then call push_changes (or sync_project) again.
- Paths are relative to the project root, e.g. "main.tex" or "chapters/intro.tex".`;

const projectArg = z
  .string()
  .min(1)
  .describe(
    'Overleaf project: its ID (from the URL overleaf.com/project/<id>), the full project URL, or its name/alias as shown by list_projects.',
  );

type ToolResult = CallToolResult;

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function withNotes(notes: string[], body: string): string {
  return notes.length ? `${notes.map((n) => `Note: ${n}`).join("\n")}\n\n${body}` : body;
}

function label(project: ProjectRef): string {
  return project.name ? `"${project.name}" (${project.id})` : project.id;
}

const KIND_LETTER: Record<FileChange["kind"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  conflicted: "U",
};

function formatChanges(changes: FileChange[], indent = "  "): string {
  return changes
    .map((c) => `${indent}${KIND_LETTER[c.kind]} ${c.from ? `${c.from} → ${c.path}` : c.path}`)
    .join("\n");
}

function conflictMessage(conflicts: string[]): string {
  return [
    `Your local edits conflict with changes made on Overleaf in ${conflicts.length} file(s):`,
    ...conflicts.map((c) => `  ${c}`),
    "",
    "These files now contain conflict markers:",
    "  <<<<<<< HEAD",
    "  (your version)",
    "  =======",
    "  (the version on Overleaf)",
    "  >>>>>>> refs/remotes/origin/master",
    "Edit each file so it contains the intended text with no markers left, then call push_changes (or sync_project) again.",
    "To give up your local edits instead, call discard_changes with all=true.",
  ].join("\n");
}

function formatSync(result: SyncResult, project: ProjectRef, dir: string): string {
  switch (result.state) {
    case "cloned":
      return `Downloaded ${label(project)} from Overleaf into ${dir}.`;
    case "conflict":
      return conflictMessage(result.conflicts);
    case "up-to-date":
    case "updated": {
      const lines: string[] = [];
      if (result.state === "up-to-date") lines.push("Already up to date with Overleaf.");
      else {
        lines.push(`Pulled ${result.remoteChanges.length} changed file(s) from Overleaf:`);
        lines.push(formatChanges(result.remoteChanges));
      }
      if (result.pendingChanges.length) {
        lines.push(`${result.pendingChanges.length} local change(s) not yet pushed:`);
        lines.push(formatChanges(result.pendingChanges));
      }
      return lines.join("\n");
    }
  }
}

function formatPush(result: PushResult): string {
  const remote = result.remoteChanges;
  const pulled = remote.length ? `\nMerged ${remote.length} change(s) from Overleaf first:\n${formatChanges(remote)}` : "";
  switch (result.state) {
    case "pushed":
      return `Pushed ${result.files.length} file(s) to Overleaf (commit ${result.commit.slice(0, 7)}):\n${formatChanges(result.files)}${pulled}`;
    case "nothing-to-push":
      return `Nothing to push: there are no local changes.${pulled}`;
    case "conflict": {
      const changed = remote.length ? `Changed on Overleaf since your last sync:\n${formatChanges(remote)}\n\n` : "";
      return `Nothing was pushed.\n${changed}${conflictMessage(result.conflicts)}`;
    }
  }
}

function numberLines(lines: string[], firstLineNumber: number): string {
  return lines
    .map((l, i) => {
      const shown = l.length > 2000 ? `${l.slice(0, 2000)}… [line truncated]` : l;
      return `${String(firstLineNumber + i).padStart(6)}\t${shown}`;
    })
    .join("\n");
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function countOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    positions.push(idx);
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return positions;
}

function lineOfOffset(textValue: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < textValue.length; i++) if (textValue[i] === "\n") line++;
  return line;
}

async function readTextFile(abs: string, rel: string): Promise<string> {
  let buf: Buffer;
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new UserError(`"${rel}" is a directory. Use list_files to see its contents.`);
    buf = await fs.readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserError(`File "${rel}" does not exist. Use list_files to see the project's files.`);
    }
    throw err;
  }
  if (isProbablyBinary(buf)) throw new UserError(`"${rel}" is a binary file and cannot be edited as text.`);
  return buf.toString("utf8");
}

function detectEngine(mainSource: string): Engine {
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|polyglossia|unicode-math|xeCJK)\b/.test(mainSource)) return "xelatex";
  if (/\\directlua|\\usepackage(\[[^\]]*\])?\{[^}]*\bluacode\b/.test(mainSource)) return "lualatex";
  return "pdflatex";
}

async function newestLog(buildRoot: string): Promise<string | undefined> {
  const candidates: string[] = [path.join(buildRoot, "overleaf", "output.log")];
  try {
    for (const f of await fs.readdir(path.join(buildRoot, "local"))) {
      if (f.endsWith(".log")) candidates.push(path.join(buildRoot, "local", f));
    }
  } catch {
    // no local builds
  }
  let best: { p: string; t: number } | undefined;
  for (const p of candidates) {
    try {
      const t = (await fs.stat(p)).mtimeMs;
      if (!best || t > best.t) best = { p, t };
    } catch {
      // missing
    }
  }
  return best?.p;
}

export function createServer(config: Config, opts: { fetch?: typeof fetch } = {}): { server: McpServer; texmex: TexMex } {
  const texmex = new TexMex(config, opts);
  const server = new McpServer(
    { name: "texmex", title: "TexMex — Overleaf", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  type Handler<A> = (args: A) => Promise<ToolResult>;
  const safe =
    <A>(fn: Handler<A>): Handler<A> =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        if (!(err instanceof UserError)) console.error("[texmex]", err);
        return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
      }
    };

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
  const localWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  // ---------------------------------------------------------------- projects

  server.registerTool(
    "list_projects",
    {
      title: "List Overleaf projects",
      description:
        "List the Overleaf projects you can work with: projects in the user's Overleaf account (when OVERLEAF_COOKIE is set), configured aliases, and projects already downloaded locally. Shows each project's ID and whether it has local changes that are not pushed yet.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Re-download the project list from Overleaf instead of using the 1-minute cache."),
      },
      annotations: readOnly,
    },
    safe(async ({ refresh }) => {
      const rows = new Map<string, { id: string; name?: string; access?: string; tags: Set<string> }>();
      const add = (id: string, name: string | undefined, tag: string, access?: string) => {
        const row = rows.get(id) ?? { id, tags: new Set<string>() };
        row.name ??= name;
        row.access ??= access;
        row.tags.add(tag);
        rows.set(id, row);
      };
      const notes: string[] = [];
      for (const a of texmex.aliasEntries()) add(a.id, a.name, "alias");
      if (texmex.web) {
        try {
          for (const p of await texmex.webProjects(!!refresh)) add(p.id, p.name, "account", p.accessLevel);
        } catch (err) {
          notes.push(`Could not load projects from Overleaf: ${errorMessage(err)}`);
        }
      }
      for (const id of await texmex.localProjectIds()) add(id, await texmex.registry.name(id), "local");

      notes.push(...config.credentialWarnings);
      if (!config.gitToken && !hasCookie(config)) {
        notes.push(
          "No Overleaf credentials are configured, so projects cannot be downloaded or pushed. Set OVERLEAF_COOKIE (works with free accounts) or OVERLEAF_GIT_TOKEN (paid plans).",
        );
      }
      if (!rows.size) {
        return text(
          withNotes(
            notes,
            "No projects known yet. Pass an Overleaf project URL or ID (overleaf.com/project/<id>) directly as `project` to any tool, set OVERLEAF_PROJECTS=name=<id>,... for aliases, or set OVERLEAF_COOKIE to list the projects in your account.",
          ),
        );
      }
      const lines: string[] = [`${rows.size} project(s):`];
      for (const row of rows.values()) {
        let local = "not downloaded";
        if (row.tags.has("local")) {
          try {
            const status = await texmex.workspace(row.id).status();
            local = status.conflicted.length
              ? `downloaded, ${status.conflicted.length} unresolved conflict(s)`
              : status.changes.length
                ? `downloaded, ${status.changes.length} change(s) not pushed`
                : "downloaded, no local changes";
          } catch {
            local = "downloaded";
          }
        }
        const access = row.access ? `, ${row.access}` : "";
        lines.push(`- ${row.name ? `"${row.name}"` : "(unnamed)"} — id ${row.id}${access} — ${local}`);
      }
      lines.push("", "Use the name or ID as the `project` argument of the other tools.");
      return text(withNotes(notes, lines.join("\n")));
    }),
  );

  server.registerTool(
    "sync_project",
    {
      title: "Sync with Overleaf",
      description:
        "Download the latest version of the project from Overleaf (cloning it on first use). Local edits that are not pushed yet are kept and merged with collaborators' changes. If both changed the same lines, the files get conflict markers that must be resolved before pushing. Other tools also fetch automatically every few minutes; call this to be sure you see the newest version.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    safe(async ({ project }) =>
      texmex.withProject(
        project,
        async ({ ws, project: p }) => {
          const result = await ws.sync();
          return text(formatSync(result, p, ws.dir));
        },
        { autoSync: false },
      ),
    ),
  );

  // ------------------------------------------------------------ reading

  server.registerTool(
    "list_files",
    {
      title: "List project files",
      description: "List the files in an Overleaf project (or one of its folders) with sizes, marking the main document and files with unpushed local changes.",
      inputSchema: {
        project: projectArg,
        path: z.string().optional().describe('Folder to list, relative to the project root (default: whole project), e.g. "chapters".'),
      },
      annotations: readOnly,
    },
    safe(async ({ project, path: sub }) =>
      texmex.withProject(project, async ({ ws, notes }) => {
        if (sub) await safeProjectPath(ws.dir, sub, { allowRoot: true });
        const files = await walkFiles(ws.dir, sub ?? "");
        const status = await ws.status();
        const changed = new Map(status.changes.map((c) => [c.path, c.kind]));
        const main = await detectMainFile(ws.dir);
        const total = files.reduce((s, f) => s + f.size, 0);
        const lines = [`${files.length} file(s), ${formatBytes(total)}${sub ? ` in ${sub}` : ""}:`];
        for (const f of files) {
          const tags: string[] = [];
          if (f.path === main) tags.push("main document");
          const kind = changed.get(f.path);
          if (kind) tags.push(`${kind}, not pushed`);
          lines.push(`${f.path}  (${formatBytes(f.size)})${tags.length ? `  [${tags.join("; ")}]` : ""}`);
        }
        const deleted = status.changes.filter((c) => c.kind === "deleted");
        if (deleted.length) lines.push("", `Deleted locally (not pushed): ${deleted.map((d) => d.path).join(", ")}`);
        return text(withNotes(notes, lines.join("\n")));
      }),
    ),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a project file",
      description:
        "Read a file from an Overleaf project. Text is returned with line numbers (the numbers and the tab after them are not part of the file). Images (PNG/JPEG/GIF/WebP) are returned as images. Use offset/limit to page through long files.",
      inputSchema: {
        project: projectArg,
        path: z.string().min(1).describe('File path relative to the project root, e.g. "main.tex".'),
        offset: z.number().int().min(1).optional().describe("First line to return (1-based). Default 1."),
        limit: z.number().int().min(1).optional().describe("Maximum number of lines to return. Default 2000."),
      },
      annotations: readOnly,
    },
    safe(async ({ project, path: rel, offset, limit }) =>
      texmex.withProject(project, async ({ ws, notes }) => {
        const abs = await safeProjectPath(ws.dir, rel);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          throw new UserError(`File "${rel}" does not exist. Use list_files to see the project's files.`);
        }
        if (stat.isDirectory()) throw new UserError(`"${rel}" is a directory. Use list_files to see its contents.`);
        const ext = path.extname(abs).toLowerCase();
        if (IMAGE_MIME[ext] && stat.size <= 5 * 1024 * 1024) {
          const data = (await fs.readFile(abs)).toString("base64");
          return {
            content: [
              { type: "text", text: withNotes(notes, `${rel} (${formatBytes(stat.size)} image)`) },
              { type: "image", data, mimeType: IMAGE_MIME[ext] },
            ],
          };
        }
        const buf = await fs.readFile(abs);
        if (isProbablyBinary(buf)) {
          return text(withNotes(notes, `${rel} is a binary file (${formatBytes(stat.size)}); it cannot be shown as text.`));
        }
        const lines = splitLines(buf.toString("utf8"));
        if (buf.length === 0) return text(withNotes(notes, `${rel} is empty.`));
        const start = offset ?? 1;
        if (start > lines.length) throw new UserError(`${rel} has only ${lines.length} line(s); offset ${start} is past the end.`);
        const count = limit ?? 2000;
        const slice = lines.slice(start - 1, start - 1 + count);
        const end = start - 1 + slice.length;
        const header =
          start === 1 && end === lines.length
            ? `${rel} (${lines.length} lines)`
            : `${rel} (lines ${start}-${end} of ${lines.length}; use offset to read more)`;
        return text(withNotes(notes, `${header}\n${numberLines(slice, start)}`));
      }),
    ),
  );

  server.registerTool(
    "search_project",
    {
      title: "Search project files",
      description:
        "Search the text files of an Overleaf project for a string or regular expression and return matching lines as path:line: text. Useful to find where a command, label, citation or phrase is used.",
      inputSchema: {
        project: projectArg,
        pattern: z.string().min(1).describe("Text to search for (or a JavaScript regular expression if regex=true)."),
        regex: z.boolean().optional().describe("Treat pattern as a regular expression. Default false."),
        case_sensitive: z.boolean().optional().describe("Default false."),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.tex", "chapters/**", "*.{tex,bib}".'),
        context: z.number().int().min(0).max(10).optional().describe("Lines of context before and after each match. Default 0."),
        max_results: z.number().int().min(1).max(1000).optional().describe("Maximum matches to return. Default 100."),
      },
      annotations: readOnly,
    },
    safe(async ({ project, pattern, regex, case_sensitive, glob, context, max_results }) =>
      texmex.withProject(project, async ({ ws, notes }) => {
        let re: RegExp;
        try {
          const source = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          re = new RegExp(source, case_sensitive ? "" : "i");
        } catch (err) {
          throw new UserError(`Invalid regular expression: ${errorMessage(err)}`);
        }
        const filter = glob ? globToRegExp(glob) : undefined;
        const max = max_results ?? 100;
        const ctx = context ?? 0;
        const out: string[] = [];
        let matches = 0;
        const matchedFiles = new Set<string>();
        let truncated = false;
        for (const f of await walkFiles(ws.dir)) {
          if (filter && !filter.test(f.path)) continue;
          if (f.size > 5 * 1024 * 1024) continue;
          const buf = await fs.readFile(path.join(ws.dir, f.path));
          if (isProbablyBinary(buf)) continue;
          const lines = splitLines(buf.toString("utf8"));
          let lastPrinted = -1;
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            if (matches >= max) {
              truncated = true;
              break;
            }
            matches++;
            matchedFiles.add(f.path);
            if (ctx === 0) {
              out.push(`${f.path}:${i + 1}: ${lines[i]}`);
              continue;
            }
            const from = Math.max(i - ctx, lastPrinted + 1);
            if (lastPrinted >= 0 && from > lastPrinted + 1) out.push("--");
            else if (lastPrinted < 0 && out.length) out.push("--");
            for (let j = from; j <= Math.min(i + ctx, lines.length - 1); j++) {
              out.push(`${f.path}${j === i ? ":" : "-"}${j + 1}${j === i ? ":" : "-"} ${lines[j]}`);
              lastPrinted = j;
            }
          }
          if (truncated) break;
        }
        if (!matches) return text(withNotes(notes, `No matches for ${JSON.stringify(pattern)}${glob ? ` in ${glob}` : ""}.`));
        const header = `${matches} match(es) in ${matchedFiles.size} file(s)${truncated ? ` (stopped at ${max}; narrow the search or raise max_results)` : ""}:`;
        return text(withNotes(notes, `${header}\n${out.join("\n")}`));
      }),
    ),
  );

  server.registerTool(
    "get_outline",
    {
      title: "Document outline and static checks",
      description:
        "Summarise the structure of the LaTeX document: main file, included files, section hierarchy with file:line locations and labels, bibliography files — plus a quick static check for missing \\input files, missing images, undefined \\ref labels, citation keys missing from the .bib files, and duplicate labels. Fast; does not compile.",
      inputSchema: {
        project: projectArg,
        main_file: z.string().optional().describe("Root .tex file. Default: detected automatically (the file with \\documentclass, preferring main.tex)."),
      },
      annotations: readOnly,
    },
    safe(async ({ project, main_file }) =>
      texmex.withProject(project, async ({ ws, notes }) => {
        if (main_file) {
          const abs = await safeProjectPath(ws.dir, main_file);
          if (!(await pathExists(abs))) throw new UserError(`Main file "${main_file}" does not exist.`);
        }
        const main = await detectMainFile(ws.dir, main_file);
        if (!main) throw new UserError("The project has no .tex files.");
        const a = await analyzeProject(ws.dir, main);
        const issues = findIssues(a);
        const lines: string[] = [];
        lines.push(`Main file: ${main}${a.documentClass ? ` (\\documentclass{${a.documentClass}})` : ""}`);
        if (a.title) lines.push(`Title: ${a.title}`);
        lines.push(`TeX files in document (${a.files.length}): ${a.files.join(", ")}`);
        lines.push("", "Outline:");
        if (!a.sections.length) lines.push("  (no sectioning commands found)");
        const minLevel = Math.min(...a.sections.map((s) => s.level));
        for (const s of a.sections.slice(0, 400)) {
          const indent = "  ".repeat(s.level - minLevel + 1);
          lines.push(
            `${indent}${s.command}${s.starred ? "*" : ""}: ${s.title}${s.label ? `  [${s.label}]` : ""}  — ${s.file}:${s.line}`,
          );
        }
        if (a.sections.length > 400) lines.push(`  … ${a.sections.length - 400} more`);
        const bibs = a.bibFiles.map((b) => b.resolved ?? `${b.target} (missing)`);
        lines.push(
          "",
          `Labels: ${a.labels.length}, references: ${a.refs.length}, citations: ${a.citations.length} (${new Set(a.citations.map((c) => c.name)).size} distinct), figures/images: ${a.graphics.length}`,
        );
        if (bibs.length) lines.push(`Bibliography: ${bibs.join(", ")} (${a.bibKeys.size} entries)`);
        lines.push("");
        if (!issues.length) lines.push("Static check: no problems found.");
        else {
          lines.push(`Static check found ${issues.length} possible problem(s):`);
          for (const issue of issues.slice(0, 60)) {
            lines.push(`  - ${issue.file ? `${issue.file}:${issue.line} ` : ""}${issue.message}`);
          }
          if (issues.length > 60) lines.push(`  … and ${issues.length - 60} more`);
        }
        return text(withNotes(notes, lines.join("\n")));
      }),
    ),
  );

  server.registerTool(
    "get_status",
    {
      title: "Local changes and sync status",
      description:
        "Show which files have local changes that are not on Overleaf yet, unresolved merge conflicts, whether Overleaf has newer changes, and where the local working copy lives on disk.",
      inputSchema: { project: projectArg },
      annotations: readOnly,
    },
    safe(async ({ project }) =>
      texmex.withProject(project, async ({ ws, project: p, notes }) => {
        const s = await ws.status();
        const main = await detectMainFile(ws.dir);
        const fetched = ws.lastFetch ? `${Math.round((Date.now() - ws.lastFetch) / 1000)}s ago` : "not in this session";
        const lines = [
          `Project: ${label(p)}`,
          `Local working copy: ${ws.dir}`,
          `Overleaf version: ${s.remoteHead?.slice(0, 7) ?? "unknown"} (branch ${s.branch}, last checked ${fetched})`,
          `Main file: ${main ?? "(none found)"}`,
        ];
        if (s.behind) lines.push(`Overleaf has ${s.behind} newer commit(s) not merged locally — call sync_project.`);
        if (s.mergeInProgress) {
          lines.push(
            s.conflicted.length
              ? `Merge in progress with ${s.conflicted.length} conflicted file(s): ${s.conflicted.join(", ")}. Resolve the markers, then push_changes or sync_project.`
              : "Merge in progress; conflicts look resolved — call push_changes or sync_project to finish.",
          );
        }
        if (!s.changes.length) lines.push("No local changes: the working copy matches Overleaf.");
        else {
          lines.push(`${s.changes.length} local change(s) not yet pushed to Overleaf:`);
          lines.push(formatChanges(s.changes));
        }
        return text(withNotes(notes, lines.join("\n")));
      }),
    ),
  );

  server.registerTool(
    "get_diff",
    {
      title: "Diff of local changes",
      description:
        "Show a unified diff of local changes that are not pushed to Overleaf yet (including new files). With `since`, show everything that changed since that commit (use get_history to find commit hashes), e.g. to review what collaborators changed.",
      inputSchema: {
        project: projectArg,
        paths: z.array(z.string()).optional().describe("Limit the diff to these files or folders."),
        since: z.string().optional().describe("Commit hash to diff against instead of the current Overleaf version."),
        stat: z.boolean().optional().describe("Only show a per-file summary of changed lines."),
      },
      annotations: readOnly,
    },
    safe(async ({ project, paths, since, stat }) =>
      texmex.withProject(project, async ({ ws, notes }) => {
        const diff = await ws.diff({ paths, since, stat });
        if (!diff.trim()) return text(withNotes(notes, since ? `No changes since ${since}.` : "No local changes: the working copy matches Overleaf."));
        const limit = 80_000;
        const body = diff.length > limit ? `${diff.slice(0, limit)}\n… diff truncated (${diff.length} characters); pass paths to narrow it.` : diff;
        return text(withNotes(notes, body));
      }),
    ),
  );

  server.registerTool(
    "get_history",
    {
      title: "Project history",
      description:
        "List recent versions of the project (newest first) with author, time and changed files. With a Git token this is Overleaf's full Git history; with the free cookie-based sync it lists the versions TexMex has downloaded or pushed.",
      inputSchema: {
        project: projectArg,
        limit: z.number().int().min(1).max(200).optional().describe("Number of commits. Default 15."),
        path: z.string().optional().describe("Only commits that touched this file or folder."),
      },
      annotations: readOnly,
    },
    safe(async ({ project, limit, path: file }) =>
      texmex.withProject(project, async ({ ws, notes }) => {
        const commits = await ws.log(limit ?? 15, file);
        if (!commits.length) return text(withNotes(notes, "No history found."));
        const lines: string[] = [];
        for (const c of commits) {
          lines.push(`${c.hash.slice(0, 10)}  ${c.date.replace("T", " ").slice(0, 16)}  ${c.author}  ${JSON.stringify(c.subject)}`);
          if (c.files.length) {
            const shown = c.files.slice(0, 12).map((f) => `${KIND_LETTER[f.kind]} ${f.path}`);
            lines.push(`    ${shown.join(", ")}${c.files.length > 12 ? `, … (${c.files.length} files)` : ""}`);
          }
        }
        return text(withNotes(notes, lines.join("\n")));
      }),
    ),
  );

  // ------------------------------------------------------------ compiling

  server.registerTool(
    "compile",
    {
      title: "Compile the document",
      description:
        'Compile the LaTeX project and report errors and warnings with file:line locations. where="overleaf" compiles on Overleaf\'s servers (needs OVERLEAF_COOKIE; compiles the last PUSHED version, exactly as collaborators see it). where="local" runs latexmk on this machine on the local working copy, including unpushed edits (needs a TeX installation). Default "auto": local if latexmk is available and there are unpushed changes, otherwise Overleaf when configured.',
      inputSchema: {
        project: projectArg,
        where: z.enum(["auto", "overleaf", "local"]).optional().describe('Default "auto".'),
        main_file: z.string().optional().describe("Local compile only: root .tex file (default: detected)."),
        engine: z
          .enum(["auto", "pdflatex", "xelatex", "lualatex", "latex"])
          .optional()
          .describe('Local compile only. Default "auto" (xelatex if the document loads fontspec/polyglossia/unicode-math, lualatex if it uses \\directlua, else pdflatex). Overleaf uses the compiler chosen in the project\'s settings.'),
        draft: z.boolean().optional().describe("Overleaf only: fast draft mode (images replaced by boxes)."),
        clean: z.boolean().optional().describe("Local only: delete previous build files first."),
        include_bad_boxes: z.boolean().optional().describe("Also list overfull/underfull box warnings."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ project, where, main_file, engine, draft, clean, include_bad_boxes }) =>
      texmex.withProject(project, async ({ ws, project: p, notes }) => {
        const status = await ws.status();
        let target = where ?? "auto";
        if (target === "auto") {
          if (!texmex.web) target = "local";
          else if (status.changes.length && (await commandExists(config.latexmkPath))) target = "local";
          else target = "overleaf";
        }
        const buildRoot = texmex.buildDir(p.id);
        if (target === "overleaf") {
          if (!texmex.web) {
            throw new UserError('Compiling on Overleaf needs OVERLEAF_COOKIE (your overleaf_session2 browser cookie). Use where="local" to compile with a local TeX installation instead.');
          }
          if (status.changes.length) {
            notes.push(`${status.changes.length} local change(s) are not pushed, so Overleaf compiled the last pushed version. Push first, or compile with where="local".`);
          }
          const outcome = await compileOnOverleaf(texmex.web, p.id, buildRoot, { draft });
          return text(withNotes(notes, formatCompileOutcome(outcome, { includeTypesetting: include_bad_boxes })));
        }
        if (main_file) {
          const abs = await safeProjectPath(ws.dir, main_file);
          if (!(await pathExists(abs))) throw new UserError(`Main file "${main_file}" does not exist.`);
        }
        const main = await detectMainFile(ws.dir, main_file);
        if (!main) throw new UserError("The project has no .tex files to compile.");
        let chosen: Engine;
        if (!engine || engine === "auto") {
          chosen = detectEngine(await fs.readFile(path.join(ws.dir, main), "utf8"));
        } else chosen = engine;
        const outcome = await compileLocal(config, ws.dir, buildRoot, { mainFile: main, engine: chosen, clean });
        if (chosen !== "pdflatex") outcome.notes.unshift(`Engine: ${chosen}.`);
        return text(withNotes(notes, formatCompileOutcome(outcome, { includeTypesetting: include_bad_boxes })));
      }),
    ),
  );

  server.registerTool(
    "get_compile_log",
    {
      title: "Raw compile log",
      description: "Show the raw LaTeX log of the most recent compile (local or on Overleaf): the last lines, or only lines matching a pattern with a little context.",
      inputSchema: {
        project: projectArg,
        pattern: z.string().optional().describe("Case-insensitive regular expression; show only matching lines (±2 lines of context)."),
        lines: z.number().int().min(1).max(5000).optional().describe("Without pattern: number of lines from the end. Default 200."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ project, pattern, lines: count }) => {
      const p = await texmex.resolve(project);
      const logPath = await newestLog(texmex.buildDir(p.id));
      if (!logPath) throw new UserError("No compile log found. Run the compile tool first.");
      const all = splitLines(await fs.readFile(logPath, "utf8"));
      if (pattern) {
        let re: RegExp;
        try {
          re = new RegExp(pattern, "i");
        } catch (err) {
          throw new UserError(`Invalid regular expression: ${errorMessage(err)}`);
        }
        const keep = new Set<number>();
        all.forEach((l, i) => {
          if (re.test(l)) for (let j = Math.max(0, i - 2); j <= Math.min(all.length - 1, i + 2); j++) keep.add(j);
        });
        if (!keep.size) return text(`No lines in ${logPath} match ${JSON.stringify(pattern)}.`);
        const idx = [...keep].sort((a, b) => a - b).slice(0, 600);
        const out: string[] = [];
        idx.forEach((i, k) => {
          if (k > 0 && i !== idx[k - 1] + 1) out.push("--");
          out.push(`${i + 1}: ${all[i]}`);
        });
        return text(`${logPath} (${all.length} lines), matches for ${JSON.stringify(pattern)}:\n${out.join("\n")}`);
      }
      const n = count ?? 200;
      const start = Math.max(0, all.length - n);
      return text(`${logPath} (lines ${start + 1}-${all.length} of ${all.length}):\n${numberLines(all.slice(start), start + 1)}`);
    }),
  );

  // ------------------------------------------------------------ writing

  if (!config.readOnly) {
    server.registerTool(
      "write_file",
      {
        title: "Create or overwrite a file",
        description:
          "Create a new text file or replace the entire content of an existing one in the local working copy. Prefer edit_file for changes to existing files. Not visible on Overleaf until push_changes.",
        inputSchema: {
          project: projectArg,
          path: z.string().min(1).describe('File path relative to the project root, e.g. "chapters/results.tex". Missing folders are created.'),
          content: z.string().describe("The complete new file content."),
        },
        annotations: localWrite,
      },
      safe(async ({ project, path: rel, content }) =>
        texmex.withProject(project, async ({ ws, notes }) => {
          const abs = await safeProjectPath(ws.dir, rel);
          const existed = await pathExists(abs);
          if (existed && (await fs.stat(abs)).isDirectory()) throw new UserError(`"${rel}" is a directory.`);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, "utf8");
          const lines = splitLines(content).length;
          return text(
            withNotes(
              notes,
              `${existed ? "Overwrote" : "Created"} ${toPosix(path.relative(ws.dir, abs))} (${lines} line(s), ${formatBytes(Buffer.byteLength(content))}). Not on Overleaf until push_changes.`,
            ),
          );
        }),
      ),
    );

    server.registerTool(
      "edit_file",
      {
        title: "Edit a file (find and replace)",
        description:
          "Replace an exact piece of text in a project file. old_string must match the file exactly (including whitespace and line breaks, without the line-number prefixes shown by read_file) and must be unique unless replace_all is true — include surrounding lines to make it unique. Not visible on Overleaf until push_changes.",
        inputSchema: {
          project: projectArg,
          path: z.string().min(1).describe("File path relative to the project root."),
          old_string: z.string().min(1).describe("Exact text to replace."),
          new_string: z.string().describe("Replacement text (may be empty to delete)."),
          replace_all: z.boolean().optional().describe("Replace every occurrence. Default false."),
        },
        annotations: localWrite,
      },
      safe(async ({ project, path: rel, old_string, new_string, replace_all }) =>
        texmex.withProject(project, async ({ ws, notes }) => {
          if (old_string === new_string) throw new UserError("old_string and new_string are identical; nothing to change.");
          const abs = await safeProjectPath(ws.dir, rel);
          const content = await readTextFile(abs, rel);
          // Tolerate CRLF files when the agent sends LF text.
          const crlf = content.includes("\r\n");
          const oldS = crlf && !old_string.includes("\r\n") ? old_string.replace(/\n/g, "\r\n") : old_string;
          const newS = crlf && !new_string.includes("\r\n") ? new_string.replace(/\n/g, "\r\n") : new_string;
          const positions = countOccurrences(content, oldS);
          if (!positions.length) {
            let hint = "Make sure it matches the file exactly, including whitespace and line breaks (use read_file to see the current text).";
            if (/^\s*\d+\t/m.test(old_string)) hint = "It looks like old_string includes the line-number prefixes from read_file; remove them.";
            else if (content.includes(old_string.trim()) && old_string.trim() !== old_string) hint = "The text matches only after trimming leading/trailing whitespace; adjust the whitespace.";
            throw new UserError(`old_string was not found in ${rel}. ${hint}`);
          }
          if (positions.length > 1 && !replace_all) {
            const lineNos = positions.slice(0, 20).map((pos) => lineOfOffset(content, pos));
            throw new UserError(
              `old_string occurs ${positions.length} times in ${rel} (lines ${lineNos.join(", ")}). Include more surrounding text to make it unique, or set replace_all=true.`,
            );
          }
          let updated: string;
          if (replace_all) updated = content.split(oldS).join(newS);
          else updated = content.slice(0, positions[0]) + newS + content.slice(positions[0] + oldS.length);
          await fs.writeFile(abs, updated, "utf8");

          const replaced = replace_all ? positions.length : 1;
          const firstLine = lineOfOffset(updated, positions[0]);
          const newLines = splitLines(updated);
          const span = splitLines(newS || " ").length;
          const from = Math.max(1, firstLine - 2);
          const to = Math.min(newLines.length, firstLine + span + 1, from + 40);
          const snippet = newLines.length ? numberLines(newLines.slice(from - 1, to), from) : "(file is now empty)";
          return text(
            withNotes(
              notes,
              `Edited ${rel}: replaced ${replaced} occurrence(s). Not on Overleaf until push_changes.\n${snippet}`,
            ),
          );
        }),
      ),
    );

    server.registerTool(
      "delete_file",
      {
        title: "Delete a file",
        description: "Delete a file (or, with recursive=true, a folder) from the local working copy. Takes effect on Overleaf after push_changes; can be undone before that with discard_changes.",
        inputSchema: {
          project: projectArg,
          path: z.string().min(1).describe("File or folder path relative to the project root."),
          recursive: z.boolean().optional().describe("Required to delete a folder."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      safe(async ({ project, path: rel, recursive }) =>
        texmex.withProject(project, async ({ ws, notes }) => {
          const abs = await safeProjectPath(ws.dir, rel);
          let stat;
          try {
            stat = await fs.stat(abs);
          } catch {
            throw new UserError(`"${rel}" does not exist.`);
          }
          if (stat.isDirectory() && !recursive) throw new UserError(`"${rel}" is a folder; pass recursive=true to delete it and its contents.`);
          await fs.rm(abs, { recursive: stat.isDirectory(), force: true });
          return text(withNotes(notes, `Deleted ${rel}. Not on Overleaf until push_changes (undo with discard_changes).`));
        }),
      ),
    );

    server.registerTool(
      "move_file",
      {
        title: "Move or rename a file",
        description: "Move or rename a file or folder within the project. Remember to update \\input/\\include/\\includegraphics paths that refer to it. Not visible on Overleaf until push_changes.",
        inputSchema: {
          project: projectArg,
          from: z.string().min(1).describe("Current path relative to the project root."),
          to: z.string().min(1).describe("New path relative to the project root."),
          overwrite: z.boolean().optional().describe("Replace the destination if it exists. Default false."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      safe(async ({ project, from, to, overwrite }) =>
        texmex.withProject(project, async ({ ws, notes }) => {
          const src = await safeProjectPath(ws.dir, from);
          const dest = await safeProjectPath(ws.dir, to);
          if (!(await pathExists(src))) throw new UserError(`"${from}" does not exist.`);
          if (src === dest) throw new UserError("Source and destination are the same.");
          if (await pathExists(dest)) {
            if (!overwrite) throw new UserError(`"${to}" already exists; pass overwrite=true to replace it.`);
            await fs.rm(dest, { recursive: true, force: true });
          }
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(src, dest);
          return text(withNotes(notes, `Moved ${from} → ${to}. Not on Overleaf until push_changes.`));
        }),
      ),
    );

    server.registerTool(
      "import_file",
      {
        title: "Copy a local file into the project",
        description:
          "Copy a file from this computer into the Overleaf project, e.g. a figure or data file you generated. Works for binary files such as PNG/PDF images. Not visible on Overleaf until push_changes.",
        inputSchema: {
          project: projectArg,
          source_path: z.string().min(1).describe("Absolute path of the file on this computer."),
          dest_path: z.string().optional().describe('Destination path in the project, e.g. "figures/plot.pdf". Default: the file name at the project root.'),
          overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
        },
        annotations: localWrite,
      },
      safe(async ({ project, source_path, dest_path, overwrite }) =>
        texmex.withProject(project, async ({ ws, notes }) => {
          if (!path.isAbsolute(source_path)) throw new UserError("source_path must be an absolute path.");
          let stat;
          try {
            stat = await fs.stat(source_path);
          } catch {
            throw new UserError(`"${source_path}" does not exist.`);
          }
          if (!stat.isFile()) throw new UserError(`"${source_path}" is not a file.`);
          if (stat.size > 50 * 1024 * 1024) throw new UserError("File is larger than 50 MB, which Overleaf does not accept.");
          const dest = await safeProjectPath(ws.dir, dest_path ?? path.basename(source_path));
          if ((await pathExists(dest)) && !overwrite) throw new UserError(`"${toPosix(path.relative(ws.dir, dest))}" already exists; pass overwrite=true to replace it.`);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(source_path, dest);
          return text(
            withNotes(notes, `Copied ${source_path} → ${toPosix(path.relative(ws.dir, dest))} (${formatBytes(stat.size)}). Not on Overleaf until push_changes.`),
          );
        }),
      ),
    );

    server.registerTool(
      "push_changes",
      {
        title: "Push changes to Overleaf",
        description:
          "Publish all local changes to Overleaf, after merging any newer changes collaborators made on Overleaf. Collaborators see the result immediately. If their edits conflict with yours, nothing is pushed and the files get conflict markers to resolve first. (With a Git token this is one commit with your message; with the free cookie-based sync each changed file is uploaded and the message is only kept locally.)",
        inputSchema: {
          project: projectArg,
          message: z.string().min(1).describe("Short description of the change (shown in Overleaf's history)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safe(async ({ project, message }) =>
        texmex.withProject(
          project,
          async ({ ws }) => {
            if (!(await ws.isCloned())) await ws.clone();
            return text(formatPush(await ws.push(message)));
          },
          { autoSync: false },
        ),
      ),
    );

    server.registerTool(
      "discard_changes",
      {
        title: "Discard local changes",
        description:
          "Throw away local changes that are not pushed yet, restoring files to the current Overleaf version. Pass specific paths, or all=true to discard everything (this also aborts an unresolved merge). Cannot be undone.",
        inputSchema: {
          project: projectArg,
          paths: z.array(z.string()).optional().describe("Files or folders to restore."),
          all: z.boolean().optional().describe("Discard every local change."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      safe(async ({ project, paths, all }) =>
        texmex.withProject(
          project,
          async ({ ws }) => {
            if (!all && !paths?.length) throw new UserError("Pass the paths to discard, or all=true.");
            const discarded = await ws.discard(all ? "all" : paths!);
            if (!discarded.length) return text("There were no local changes to discard.");
            return text(`Discarded ${discarded.length} local change(s):\n${formatChanges(discarded)}`);
          },
          { autoSync: false },
        ),
      ),
    );
  }

  // ------------------------------------------------------------ prompts

  server.registerPrompt(
    "fix_compile_errors",
    {
      title: "Fix compile errors",
      description: "Compile an Overleaf project, fix its LaTeX errors, and prepare the changes for review.",
      argsSchema: { project: z.string().describe("Overleaf project name, ID or URL") },
    },
    ({ project }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Using the Overleaf tools, fix the LaTeX errors in the project ${JSON.stringify(project)}.
1. sync_project, then compile it.
2. For each error, read the relevant lines and make the smallest correct fix with edit_file. Also fix undefined references/citations when the intended target is clear; otherwise list them for me.
3. Recompile until there are no errors (or only ones you cannot fix without my input).
4. Show me get_diff and a short summary, and ask before pushing to Overleaf.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_recent_changes",
    {
      title: "Review collaborators' changes",
      description: "Summarise what changed in an Overleaf project recently.",
      argsSchema: { project: z.string().describe("Overleaf project name, ID or URL") },
    },
    ({ project }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Using the Overleaf tools, review recent changes to the project ${JSON.stringify(project)}: call sync_project, then get_history, then get_diff with \`since\` set to an appropriate older commit. Summarise what changed per section/file and who changed it, and point out anything that looks like a mistake (broken references, typos, LaTeX problems).`,
          },
        },
      ],
    }),
  );

  return { server, texmex };
}
