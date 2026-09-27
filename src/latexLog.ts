export type LogLevel = "error" | "warning" | "typesetting";

export interface LogEntry {
  level: LogLevel;
  message: string;
  file?: string;
  line?: number;
  /** Relevant raw lines from the log (e.g. TeX's `l.12 \foo` context). */
  context?: string;
}

export interface ParsedLog {
  errors: LogEntry[];
  warnings: LogEntry[];
  typesetting: LogEntry[];
  pages?: number;
  outputFile?: string;
  noOutput: boolean;
}

/** TeX wraps log lines at this width (max_print_line default). */
const LOG_WRAP_LIMIT = 79;

const FILE_EXT =
  "tex|sty|cls|clo|cfg|def|fd|bbl|aux|toc|lof|lot|out|ltx|ldf|dict|tikz|pgf|lbx|cbx|bbx|dbx|nav|snm|ind|gls|lco|mkii|code\\.tex|w18|dtx|ins|ist|bib|Rnw|pdf_tex|tikzstyles";
const FILE_LINE_ERROR = new RegExp(`^((?:[A-Za-z]:)?[^:\\s][^:]*\\.(?:${FILE_EXT})):(\\d+): (.*)$`);
const PAREN_FILE = new RegExp(`^"?((?:[A-Za-z]:[\\\\/]|\\.{1,2}/|/)?[^\\s()"]*\\.(?:${FILE_EXT}))(?="|\\s|\\)|$)`);

/** Help text TeX prints in interactive prompts; useless as error context. */
const PROMPT_NOISE =
  /^(Type +[XH] |or enter new name|Enter file name|! Emergency stop|<(read|insert) |<\*> |See the .* manual|You're in trouble|Try typing|\(Press Enter)/;

export interface ParseOptions {
  /** Absolute directory prefixes to strip from file names (e.g. the build dir). */
  stripPrefixes?: string[];
}

function unwrapLines(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < raw.length; i++) {
    buf += raw[i];
    // A line that is exactly the wrap width was (almost always) wrapped by TeX.
    if (raw[i].length === LOG_WRAP_LIMIT && i + 1 < raw.length) continue;
    out.push(buf);
    buf = "";
  }
  if (buf) out.push(buf);
  return out;
}

export function parseLatexLog(text: string, opts: ParseOptions = {}): ParsedLog {
  const lines = unwrapLines(text);
  const result: ParsedLog = { errors: [], warnings: [], typesetting: [], noOutput: false };
  const stack: Array<string | null> = [];

  const clean = (file: string | undefined): string | undefined => {
    if (!file) return undefined;
    let f = file.replace(/^"|"$/g, "");
    for (const prefix of [...(opts.stripPrefixes ?? []), "/compile/"]) {
      const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
      if (f.startsWith(p)) f = f.slice(p.length);
    }
    return f.replace(/^\.\//, "");
  };
  const currentFile = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return clean(stack[i]!);
    return undefined;
  };

  const updateStack = (line: string) => {
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === "(") {
        const m = PAREN_FILE.exec(line.slice(j + 1));
        if (m) {
          stack.push(m[1]);
          j += m[0].length;
        } else {
          stack.push(null);
        }
      } else if (c === ")") {
        stack.pop();
      }
    }
  };

  /** Collect TeX's error context up to and including the `l.<n>` line. */
  const readErrorContext = (start: number): { line?: number; context: string[]; next: number } => {
    const context: string[] = [];
    let i = start;
    for (; i < lines.length && i < start + 20; i++) {
      const l = lines[i];
      if (l.startsWith("! ") && !l.startsWith("! Emergency stop")) break;
      if (FILE_LINE_ERROR.test(l)) break;
      const m = /^l\.(\d+) ?(.*)$/.exec(l);
      if (m) {
        context.push(l.replace(/\^\^M$/, ""));
        // TeX prints the rest of the source line on the following line.
        if (i + 1 < lines.length && lines[i + 1].trim() && /^\s+/.test(lines[i + 1])) {
          context.push(lines[i + 1].replace(/\^\^M$/, ""));
          i++;
        }
        return { line: Number(m[1]), context, next: i + 1 };
      }
      if (l.trim() && context.length < 6 && !PROMPT_NOISE.test(l)) context.push(l);
    }
    return { context: [], next: start };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fle = FILE_LINE_ERROR.exec(line);
    if (fle) {
      const ctx = readErrorContext(i + 1);
      result.errors.push({
        level: "error",
        message: fle[3].trim(),
        file: clean(fle[1]),
        line: Number(fle[2]),
        context: ctx.context.join("\n") || undefined,
      });
      i = ctx.next > i + 1 ? ctx.next : i + 1;
      continue;
    }

    if (line.startsWith("! ")) {
      const ctx = readErrorContext(i + 1);
      result.errors.push({
        level: "error",
        message: line.slice(2).trim(),
        file: currentFile(),
        line: ctx.line,
        context: ctx.context.join("\n") || undefined,
      });
      i = ctx.next > i + 1 ? ctx.next : i + 1;
      continue;
    }

    const warn = /^(?:(LaTeX)|Package ([\w.@-]+)|Class ([\w.@-]+)|(LaTeX Font)) Warning: (.*)$/.exec(line);
    if (warn) {
      const source = warn[2] ?? warn[3];
      const prefix = source ? `(${source})` : warn[4] ? "(Font)" : null;
      let message = warn[5].trim();
      let j = i + 1;
      while (j < lines.length && lines[j].trim()) {
        const cont = lines[j];
        if (prefix && cont.startsWith(prefix)) {
          message += ` ${cont.slice(prefix.length).trim()}`;
        } else if (!prefix && /^\s+\S/.test(cont)) {
          message += ` ${cont.trim()}`;
        } else {
          break;
        }
        j++;
      }
      const lineMatch = /on input line (\d+)/.exec(message);
      result.warnings.push({
        level: "warning",
        message: source && !message.startsWith(source) ? `${source}: ${message}` : message,
        file: currentFile(),
        line: lineMatch ? Number(lineMatch[1]) : undefined,
      });
      i = j;
      continue;
    }

    const box = /^((?:Over|Under)full \\[hv]box .*)$/.exec(line);
    if (box) {
      const m =
        /at lines? (\d+)(?:--(\d+))?/.exec(line) ?? /detected at line (\d+)/.exec(line);
      result.typesetting.push({
        level: "typesetting",
        message: box[1].trim(),
        file: currentFile(),
        line: m ? Number(m[1]) : undefined,
      });
      // Skip the box contents: they are TeX's rendering of the material and
      // contain parentheses that would corrupt the file stack.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && j < i + 12) j++;
      i = j;
      continue;
    }

    const output = /^Output written on (.+?) \((\d+) pages?/.exec(line);
    if (output) {
      result.outputFile = clean(output[1]);
      result.pages = Number(output[2]);
    } else if (/^No pages of output\./.test(line)) {
      result.noOutput = true;
    }

    updateStack(line);
    i++;
  }

  // "Emergency stop" and friends are consequences of an earlier error.
  const consequential = /^(Emergency stop|==> Fatal error occurred|Job aborted)/;
  if (result.errors.some((e) => !consequential.test(e.message))) {
    result.errors = result.errors.filter((e) => !consequential.test(e.message));
  }
  result.errors = dedupe(result.errors);
  result.warnings = dedupe(result.warnings);
  return result;
}

function dedupe(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface BibLogResult {
  errors: LogEntry[];
  warnings: LogEntry[];
}

/** Parse a BibTeX or Biber `.blg` log. */
export function parseBibLog(text: string): BibLogResult {
  const result: BibLogResult = { errors: [], warnings: [] };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Biber: "[123] Utils.pm:209> WARN - message" / "ERROR - message"
    const biber = /(?:^|> )(ERROR|WARN) - (.*)$/.exec(line);
    if (biber) {
      const entry: LogEntry = { level: biber[1] === "ERROR" ? "error" : "warning", message: biber[2].trim() };
      const loc = /line (\d+)[^,]*, .*?'([^']+\.bib)'/.exec(biber[2]);
      if (loc) {
        entry.line = Number(loc[1]);
        entry.file = loc[2];
      }
      (entry.level === "error" ? result.errors : result.warnings).push(entry);
      continue;
    }
    // BibTeX warnings
    const bw = /^Warning--(.*)$/.exec(line);
    if (bw) {
      const entry: LogEntry = { level: "warning", message: bw[1].trim() };
      const loc = /^--line (\d+) of file (.*)$/.exec(lines[i + 1] ?? "");
      if (loc) {
        entry.line = Number(loc[1]);
        entry.file = loc[2].trim();
        i++;
      }
      result.warnings.push(entry);
      continue;
    }
    // BibTeX errors: "<message>---line 12 of file refs.bib"
    const be = /^(.*)---line (\d+) of file (.*)$/.exec(line);
    if (be) {
      result.errors.push({ level: "error", message: be[1].trim() || "BibTeX error", line: Number(be[2]), file: be[3].trim() });
      continue;
    }
    if (/^I (couldn't open|found no|was expecting)|^Illegal, /.test(line)) {
      result.errors.push({ level: "error", message: line.trim() });
    }
  }
  return result;
}
