import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "./files.js";

export interface Located {
  file: string;
  line: number;
}

export interface SectionEntry extends Located {
  command: string;
  level: number;
  starred: boolean;
  title: string;
  label?: string;
}

export interface IncludeEntry extends Located {
  command: string;
  target: string;
  resolved?: string;
}

export interface NamedRef extends Located {
  name: string;
  command: string;
}

export interface ProjectAnalysis {
  mainFile: string;
  documentClass?: string;
  title?: string;
  files: string[];
  sections: SectionEntry[];
  includes: IncludeEntry[];
  labels: NamedRef[];
  refs: NamedRef[];
  citations: NamedRef[];
  graphics: IncludeEntry[];
  bibFiles: IncludeEntry[];
  bibKeys: Set<string>;
  hasThebibliography: boolean;
}

export interface AnalysisIssue extends Partial<Located> {
  kind: "missing-file" | "missing-graphic" | "missing-bib" | "undefined-ref" | "undefined-cite" | "duplicate-label";
  message: string;
}

const SECTION_LEVELS: Record<string, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

const REF_COMMANDS = new Set([
  "ref", "eqref", "pageref", "autoref", "Autoref", "cref", "Cref", "cpageref", "Cpageref", "nameref",
  "Nameref", "vref", "Vref", "vpageref", "labelcref", "subref", "crefrange", "Crefrange", "zcref",
]);
const NON_CITE_COMMANDS = new Set(["citestyle", "defcitealias", "citeindextrue", "citeindexfalse", "citeindextype"]);
const VERBATIM_ENVS = /^(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|filecontents\*?)$/;
const GRAPHIC_EXTS = ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps", ".svg", ".gif", ".tif", ".tiff", ".PDF", ".PNG", ".JPG"];

/** Remove comments while preserving line structure (so offsets map to lines). */
export function stripComments(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let verbatimEnd: string | null = null;
  for (const line of lines) {
    if (verbatimEnd) {
      if (line.includes(verbatimEnd)) verbatimEnd = null;
      out.push("");
      continue;
    }
    let cut = line.length;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") {
        i++;
        continue;
      }
      if (line[i] === "%") {
        cut = i;
        break;
      }
    }
    const kept = line.slice(0, cut);
    const begin = /\\begin\{([^}]+)\}/.exec(kept);
    if (begin && VERBATIM_ENVS.test(begin[1]) && !kept.includes(`\\end{${begin[1]}}`)) {
      verbatimEnd = `\\end{${begin[1]}}`;
      out.push(kept.slice(0, begin.index + begin[0].length));
      continue;
    }
    out.push(kept);
  }
  return out.join("\n");
}

/** Read a balanced group starting at `pos` (which must be `open`). Returns content and end index. */
function readGroup(text: string, pos: number, open: string, close: string): { content: string; end: number } | null {
  if (text[pos] !== open) return null;
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { content: text.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

function skipSpaces(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}

interface ParsedCommand {
  name: string;
  starred: boolean;
  optional: string[];
  args: string[];
  index: number;
  end: number;
}

/** Parse `\name*[opt]...{arg}...` at a position right after the command name. */
function parseArgs(text: string, name: string, index: number, afterName: number, mandatory: number): ParsedCommand {
  let pos = afterName;
  let starred = false;
  if (text[pos] === "*") {
    starred = true;
    pos++;
  }
  const optional: string[] = [];
  const args: string[] = [];
  for (;;) {
    const p = skipSpaces(text, pos);
    if (text[p] === "[") {
      const g = readGroup(text, p, "[", "]");
      if (!g) break;
      optional.push(g.content);
      pos = g.end;
      continue;
    }
    if (args.length < mandatory && text[p] === "{") {
      const g = readGroup(text, p, "{", "}");
      if (!g) break;
      args.push(g.content);
      pos = g.end;
      continue;
    }
    break;
  }
  return { name, starred, optional, args, index, end: pos };
}

function lineIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 160);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Pick the most likely root document of a project. */
export async function detectMainFile(root: string, preferred?: string): Promise<string | undefined> {
  if (preferred) return preferred.replace(/^\.?\/+/, "");
  const files = (await walkFiles(root)).filter((f) => f.path.toLowerCase().endsWith(".tex"));
  const candidates: string[] = [];
  for (const f of files) {
    if (f.size > 5 * 1024 * 1024) continue;
    const text = stripComments(await fs.readFile(path.join(root, f.path), "utf8"));
    const m = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(text);
    if (m && !/^(subfiles|standalone)$/.test(m[1].trim())) candidates.push(f.path);
  }
  const rank = (p: string) => {
    const base = path.posix.basename(p).toLowerCase();
    let score = p.split("/").length * 10;
    if (base === "main.tex") score -= 100;
    else if (["thesis.tex", "paper.tex", "report.tex", "article.tex", "document.tex", "root.tex"].includes(base)) score -= 50;
    return score;
  };
  candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  if (candidates.length) return candidates[0];
  if (files.some((f) => f.path === "main.tex")) return "main.tex";
  return files[0]?.path;
}

export async function analyzeProject(root: string, mainFile: string): Promise<ProjectAnalysis> {
  const analysis: ProjectAnalysis = {
    mainFile,
    files: [],
    sections: [],
    includes: [],
    labels: [],
    refs: [],
    citations: [],
    graphics: [],
    bibFiles: [],
    bibKeys: new Set(),
    hasThebibliography: false,
  };
  const visited = new Set<string>();
  const graphicsPaths: string[] = [""];

  const resolveTex = async (target: string, baseDirs: string[]): Promise<string | undefined> => {
    const t = target.trim().replace(/^"|"$/g, "");
    if (!t) return undefined;
    const names = t.endsWith(".tex") ? [t] : [`${t}.tex`, t];
    for (const dir of baseDirs) {
      for (const n of names) {
        const rel = path.posix.normalize(path.posix.join(dir, n));
        if (rel.startsWith("..")) continue;
        if (await isFile(path.join(root, rel))) return rel;
      }
    }
    return undefined;
  };

  const visit = async (rel: string, importDir: string, depth: number): Promise<void> => {
    if (visited.has(rel) || depth > 20) return;
    visited.add(rel);
    analysis.files.push(rel);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(root, rel), "utf8");
    } catch {
      return;
    }
    const text = stripComments(raw);
    const starts = lineIndex(text);
    const fileDir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    const baseDirs = [...new Set([importDir, "", fileDir])];
    const cmdRe = /\\([A-Za-z@]+)/g;
    let lastSection: SectionEntry | undefined;
    let m: RegExpExecArray | null;
    while ((m = cmdRe.exec(text))) {
      const name = m[1];
      const after = m.index + m[0].length;
      const line = lineAt(starts, m.index);
      const at = { file: rel, line };

      if (name in SECTION_LEVELS) {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (!cmd.args.length) continue;
        lastSection = {
          ...at,
          command: name,
          level: SECTION_LEVELS[name],
          starred: cmd.starred,
          title: cleanTitle(cmd.args[0]),
        };
        analysis.sections.push(lastSection);
      } else if (name === "label") {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (!cmd.args.length) continue;
        const labelName = cmd.args[0].trim();
        analysis.labels.push({ ...at, name: labelName, command: name });
        if (lastSection && !lastSection.label && lastSection.file === rel && line - lastSection.line <= 2) {
          lastSection.label = labelName;
        }
      } else if (REF_COMMANDS.has(name)) {
        const cmd = parseArgs(text, name, m.index, after, name.toLowerCase().endsWith("range") ? 2 : 1);
        for (const arg of cmd.args) {
          for (const r of arg.split(",")) if (r.trim()) analysis.refs.push({ ...at, name: r.trim(), command: name });
        }
      } else if (/cite/i.test(name) && !NON_CITE_COMMANDS.has(name)) {
        const cmd = parseArgs(text, name, m.index, after, 1);
        for (const arg of cmd.args) {
          for (const k of arg.split(",")) {
            const key = k.trim();
            if (key && key !== "*") analysis.citations.push({ ...at, name: key, command: name });
          }
        }
      } else if (["input", "include", "subfile", "InputIfFileExists", "includeonly"].includes(name)) {
        if (name === "includeonly") continue;
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (!cmd.args.length) continue; // e.g. TeX primitive `\input file`
        const target = cmd.args[0];
        const resolved = await resolveTex(target, baseDirs);
        analysis.includes.push({ ...at, command: name, target, resolved });
        if (resolved) await visit(resolved, importDir, depth + 1);
      } else if (["import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"].includes(name)) {
        const cmd = parseArgs(text, name, m.index, after, 2);
        if (cmd.args.length < 2) continue;
        const dir = cmd.args[0].trim().replace(/\/+$/, "");
        const relative = name.startsWith("sub");
        const newImportDir = path.posix.normalize(relative ? path.posix.join(fileDir, dir) : dir).replace(/^\.$/, "");
        const target = path.posix.join(dir, cmd.args[1].trim());
        const resolved = await resolveTex(cmd.args[1], [newImportDir]);
        analysis.includes.push({ ...at, command: name, target, resolved });
        if (resolved) await visit(resolved, newImportDir, depth + 1);
      } else if (name === "includegraphics" || name === "includesvg") {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (!cmd.args.length) continue;
        const target = cmd.args[0].trim();
        let resolved: string | undefined;
        outer: for (const gp of [...graphicsPaths, importDir, fileDir]) {
          for (const ext of GRAPHIC_EXTS) {
            const rel2 = path.posix.normalize(path.posix.join(gp, target + ext));
            if (!rel2.startsWith("..") && (await isFile(path.join(root, rel2)))) {
              resolved = rel2;
              break outer;
            }
          }
        }
        analysis.graphics.push({ ...at, command: name, target, resolved });
      } else if (name === "graphicspath") {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (!cmd.args.length) continue;
        for (const g of cmd.args[0].matchAll(/\{([^}]*)\}/g)) graphicsPaths.push(g[1].replace(/^\.\//, ""));
      } else if (name === "bibliography" || name === "addbibresource" || name === "addglobalbib") {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (!cmd.args.length) continue;
        const targets = name === "bibliography" ? cmd.args[0].split(",") : [cmd.args[0]];
        for (const t of targets.map((s) => s.trim()).filter(Boolean)) {
          const withExt = t.endsWith(".bib") ? t : `${t}.bib`;
          let resolved: string | undefined;
          for (const dir of baseDirs) {
            const rel2 = path.posix.normalize(path.posix.join(dir, withExt));
            if (await isFile(path.join(root, rel2))) {
              resolved = rel2;
              break;
            }
          }
          analysis.bibFiles.push({ ...at, command: name, target: t, resolved });
        }
      } else if (name === "documentclass" && !analysis.documentClass) {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (cmd.args.length) analysis.documentClass = cmd.args[0].trim();
      } else if (name === "title" && !analysis.title) {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (cmd.args.length) analysis.title = cleanTitle(cmd.args[0].replace(/\\\\/g, " "));
      } else if (name === "bibitem") {
        const cmd = parseArgs(text, name, m.index, after, 1);
        if (cmd.args.length) analysis.bibKeys.add(cmd.args[0].trim());
      } else if (name === "begin" && text.startsWith("{thebibliography}", after)) {
        analysis.hasThebibliography = true;
      }
    }
  };

  await visit(mainFile, "", 0);

  for (const bib of analysis.bibFiles) {
    if (!bib.resolved) continue;
    try {
      const text = await fs.readFile(path.join(root, bib.resolved), "utf8");
      for (const m of text.matchAll(/@\s*([A-Za-z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/g)) {
        if (!/^(comment|string|preamble)$/i.test(m[1])) analysis.bibKeys.add(m[2]);
      }
    } catch {
      // unreadable .bib: reported as missing below only if unresolved
    }
  }
  return analysis;
}

export function findIssues(a: ProjectAnalysis): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  for (const inc of a.includes) {
    if (!inc.resolved) {
      issues.push({ kind: "missing-file", file: inc.file, line: inc.line, message: `\\${inc.command}{${inc.target}}: file not found` });
    }
  }
  for (const g of a.graphics) {
    if (!g.resolved) {
      issues.push({ kind: "missing-graphic", file: g.file, line: g.line, message: `\\${g.command}{${g.target}}: image not found` });
    }
  }
  for (const b of a.bibFiles) {
    if (!b.resolved) {
      issues.push({ kind: "missing-bib", file: b.file, line: b.line, message: `\\${b.command}{${b.target}}: bibliography file not found` });
    }
  }
  const labelsByName = new Map<string, NamedRef[]>();
  for (const l of a.labels) labelsByName.set(l.name, [...(labelsByName.get(l.name) ?? []), l]);
  for (const [name, defs] of labelsByName) {
    if (defs.length > 1) {
      issues.push({
        kind: "duplicate-label",
        file: defs[1].file,
        line: defs[1].line,
        message: `label "${name}" is defined ${defs.length} times (${defs.map((d) => `${d.file}:${d.line}`).join(", ")})`,
      });
    }
  }
  const dynamic = (name: string) => /[#\\]/.test(name);
  for (const r of a.refs) {
    if (!labelsByName.has(r.name) && !dynamic(r.name)) {
      issues.push({ kind: "undefined-ref", file: r.file, line: r.line, message: `\\${r.command}{${r.name}}: no matching \\label` });
    }
  }
  const haveBibSource = a.bibFiles.some((b) => b.resolved) || a.hasThebibliography;
  if (haveBibSource) {
    for (const c of a.citations) {
      if (!a.bibKeys.has(c.name) && !dynamic(c.name)) {
        issues.push({ kind: "undefined-cite", file: c.file, line: c.line, message: `\\${c.command}{${c.name}}: key not found in bibliography` });
      }
    }
  } else if (a.citations.length) {
    issues.push({ kind: "missing-bib", message: `${a.citations.length} citation(s) but no \\bibliography, \\addbibresource or thebibliography found` });
  }
  return issues;
}
