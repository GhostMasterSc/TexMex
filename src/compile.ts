import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { UserError } from "./errors.js";
import { pathExists, walkFiles } from "./files.js";
import { parseBibLog, parseLatexLog, type BibLogResult, type LogEntry, type ParsedLog } from "./latexLog.js";
import type { OverleafWeb } from "./overleafWeb.js";

export type Engine = "pdflatex" | "xelatex" | "lualatex" | "latex";

export interface CompileOutcome {
  where: "overleaf" | "local";
  /** Raw status ("success", "failure", "timedout", ...). */
  status: string;
  success: boolean;
  mainFile?: string;
  log?: ParsedLog;
  bib?: BibLogResult;
  pdfPath?: string;
  logPath?: string;
  durationMs: number;
  notes: string[];
}

const ENGINE_FLAGS: Record<Engine, string> = {
  pdflatex: "-pdf",
  xelatex: "-pdfxe",
  lualatex: "-pdflua",
  latex: "-pdfdvi",
};

const MANIFEST = ".texmex-sources.json";

/** True if `cmd` can be executed (it exists on PATH or as a path). */
export function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["-v"], { timeout: 10_000, windowsHide: true }, (err) => {
      resolve(!err || (err as NodeJS.ErrnoException).code !== "ENOENT");
    });
  });
}

interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(cmd, args, { cwd, env, detached, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole process group: latexmk spawns the TeX engine and bibtex/biber.
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** Mirror the project into the build directory, copying only files that changed. */
async function mirrorSources(projectDir: string, buildDir: string): Promise<void> {
  const files = await walkFiles(projectDir);
  let previous: string[] = [];
  try {
    previous = JSON.parse(await fs.readFile(path.join(buildDir, MANIFEST), "utf8")) as string[];
  } catch {
    // first build
  }
  const current = new Set(files.map((f) => f.path));
  for (const old of previous) {
    if (!current.has(old)) await fs.rm(path.join(buildDir, old), { force: true });
  }
  for (const f of files) {
    const src = path.join(projectDir, f.path);
    const dest = path.join(buildDir, f.path);
    const srcStat = await fs.stat(src);
    try {
      const destStat = await fs.stat(dest);
      if (destStat.size === srcStat.size && Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < 1) continue;
    } catch {
      // missing: copy
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    await fs.utimes(dest, srcStat.atime, srcStat.mtime);
  }
  await fs.writeFile(path.join(buildDir, MANIFEST), JSON.stringify([...current]));
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

export async function compileLocal(
  config: Config,
  projectDir: string,
  buildRoot: string,
  opts: { mainFile: string; engine: Engine; clean?: boolean },
): Promise<CompileOutcome> {
  const started = Date.now();
  const buildDir = path.join(buildRoot, "local");
  if (opts.clean) await fs.rm(buildDir, { recursive: true, force: true });
  await fs.mkdir(buildDir, { recursive: true });
  await mirrorSources(projectDir, buildDir);

  const main = opts.mainFile.replace(/\\/g, "/");
  const jobBase = path.posix.basename(main).replace(/\.tex$/i, "");
  const args = [
    ...(config.allowLatexmkrc ? [] : ["-norc"]),
    ENGINE_FLAGS[opts.engine],
    "-interaction=nonstopmode",
    "-file-line-error",
    "-no-shell-escape",
    "-f",
    main,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Avoid TeX's 79-column line wrapping so the log is easy to parse.
    max_print_line: "10000",
    error_line: "254",
    half_error_line: "238",
  };

  // Remove stale outputs so we never report an old PDF as fresh.
  await fs.rm(path.join(buildDir, `${jobBase}.pdf`), { force: true });

  let result: RunResult;
  try {
    result = await run(config.latexmkPath, args, buildDir, config.compileTimeoutMs, env);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserError(
        `latexmk was not found ("${config.latexmkPath}"). Install a TeX distribution (TeX Live, MacTeX or MiKTeX) with latexmk, set TEXMEX_LATEXMK, or compile on Overleaf instead (where: "overleaf", needs OVERLEAF_COOKIE).`,
      );
    }
    throw err;
  }

  const notes: string[] = [];
  const logPath = path.join(buildDir, `${jobBase}.log`);
  const logText = await readIfExists(logPath);
  const blgText = await readIfExists(path.join(buildDir, `${jobBase}.blg`));
  const log = logText ? parseLatexLog(logText, { stripPrefixes: [buildDir] }) : undefined;
  const bib = blgText ? parseBibLog(blgText) : undefined;
  const pdfPath = path.join(buildDir, `${jobBase}.pdf`);
  const hasPdf = await pathExists(pdfPath);

  if (result.timedOut) notes.push(`Compilation timed out after ${Math.round(config.compileTimeoutMs / 1000)}s.`);
  if (!logText) {
    const tail = result.output.trim().split("\n").slice(-25).join("\n");
    notes.push(`No log file was produced. latexmk output:\n${tail}`);
  }
  const errorCount = (log?.errors.length ?? 0) + (bib?.errors.length ?? 0);
  const status = result.timedOut ? "timedout" : hasPdf ? (errorCount ? "success-with-errors" : "success") : "failure";
  return {
    where: "local",
    status,
    success: hasPdf && errorCount === 0 && !result.timedOut,
    mainFile: main,
    log,
    bib,
    pdfPath: hasPdf ? pdfPath : undefined,
    logPath: logText ? logPath : undefined,
    durationMs: Date.now() - started,
    notes,
  };
}

const OVERLEAF_STATUS_HELP: Record<string, string> = {
  failure: "Overleaf could not produce a PDF.",
  timedout: "The compile timed out on Overleaf (free plans have a short compile time limit).",
  terminated: "The compile was stopped on Overleaf.",
  "too-recently-compiled": "Overleaf rate-limited this compile; nothing changed since the last compile or it was too soon. Try again in a few seconds.",
  "autocompile-backoff": "Overleaf asked to back off; try again in a few seconds.",
  "compile-in-progress": "Another compile of this project is already running on Overleaf. Try again shortly.",
  "project-too-large": "The project is too large for Overleaf to compile.",
  "validation-problems": "Overleaf found problems with the project before compiling.",
  error: "Overleaf reported an internal error while compiling.",
  exited: "The compiler exited unexpectedly on Overleaf.",
  unavailable: "The Overleaf compile service is unavailable. Try again later.",
};

export async function compileOnOverleaf(
  web: OverleafWeb,
  projectId: string,
  buildRoot: string,
  opts: { draft?: boolean; downloadPdf?: boolean },
): Promise<CompileOutcome> {
  const started = Date.now();
  const outDir = path.join(buildRoot, "overleaf");
  await fs.mkdir(outDir, { recursive: true });
  const response = await web.compile(projectId, { draft: opts.draft });
  const notes: string[] = [];
  if (response.status !== "success" && OVERLEAF_STATUS_HELP[response.status]) {
    notes.push(OVERLEAF_STATUS_HELP[response.status]);
  }
  if (response.validationProblems) notes.push(`Validation problems: ${JSON.stringify(response.validationProblems)}`);

  const files = response.outputFiles ?? [];
  const find = (name: string) => files.find((f) => f.path === name);

  let log: ParsedLog | undefined;
  let logPath: string | undefined;
  const logFile = find("output.log");
  if (logFile) {
    const buf = await web.downloadOutput(response, logFile);
    if (buf) {
      logPath = path.join(outDir, "output.log");
      await fs.writeFile(logPath, buf);
      log = parseLatexLog(buf.toString("utf8"));
    } else {
      notes.push("Could not download output.log from Overleaf.");
    }
  }
  let bib: BibLogResult | undefined;
  const blgFile = find("output.blg");
  if (blgFile) {
    const buf = await web.downloadOutput(response, blgFile);
    if (buf) bib = parseBibLog(buf.toString("utf8"));
  }
  let pdfPath: string | undefined;
  const pdfFile = find("output.pdf");
  if (pdfFile && opts.downloadPdf !== false) {
    const buf = await web.downloadOutput(response, pdfFile);
    if (buf) {
      pdfPath = path.join(outDir, "output.pdf");
      await fs.writeFile(pdfPath, buf);
    } else {
      notes.push("The PDF was produced but could not be downloaded.");
    }
  }
  const errorCount = (log?.errors.length ?? 0) + (bib?.errors.length ?? 0);
  return {
    where: "overleaf",
    status: response.status === "success" && errorCount ? "success-with-errors" : response.status,
    success: response.status === "success" && errorCount === 0,
    log,
    bib,
    pdfPath,
    logPath,
    durationMs: Date.now() - started,
    notes,
  };
}

function formatEntry(e: LogEntry, index: number): string {
  const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : e.line ? `line ${e.line}` : "";
  let s = `${index}. ${loc ? `${loc} — ` : ""}${e.message}`;
  if (e.context) s += `\n${e.context.split("\n").map((l) => `     ${l}`).join("\n")}`;
  return s;
}

export function formatCompileOutcome(o: CompileOutcome, opts: { maxEntries?: number; includeTypesetting?: boolean } = {}): string {
  const max = opts.maxEntries ?? 25;
  const log = o.log;
  const errors = [...(log?.errors ?? []), ...(o.bib?.errors ?? []).map((e) => ({ ...e, message: `[bib] ${e.message}` }))];
  const warnings = [...(log?.warnings ?? []), ...(o.bib?.warnings ?? []).map((e) => ({ ...e, message: `[bib] ${e.message}` }))];
  const typesetting = log?.typesetting ?? [];

  const where = o.where === "overleaf" ? "on Overleaf" : `locally${o.mainFile ? ` (${o.mainFile})` : ""}`;
  const verdict = o.success ? "SUCCESS" : o.status === "success-with-errors" ? "PDF PRODUCED WITH ERRORS" : `FAILED (${o.status})`;
  const lines: string[] = [
    `Compiled ${where}: ${verdict} — ${errors.length} error(s), ${warnings.length} warning(s), ${typesetting.length} bad box(es) in ${(o.durationMs / 1000).toFixed(1)}s.`,
  ];
  if (log?.pages !== undefined) lines.push(`Output: ${log.pages} page(s).`);
  if (o.pdfPath) lines.push(`PDF: ${o.pdfPath}`);
  for (const n of o.notes) lines.push(n);

  const section = (title: string, entries: LogEntry[]) => {
    if (!entries.length) return;
    lines.push("", `${title}:`);
    entries.slice(0, max).forEach((e, i) => lines.push(formatEntry(e, i + 1)));
    if (entries.length > max) lines.push(`… and ${entries.length - max} more (see get_compile_log).`);
  };
  section("Errors", errors);
  section("Warnings", warnings);
  if (opts.includeTypesetting) section("Bad boxes", typesetting);
  else if (typesetting.length) lines.push("", `(${typesetting.length} overfull/underfull box warning(s) hidden; pass include_bad_boxes=true to list them.)`);
  if (o.logPath) lines.push("", "Full log available via get_compile_log.");
  return lines.join("\n");
}
