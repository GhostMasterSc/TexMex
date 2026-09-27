import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBibLog, parseLatexLog } from "../src/latexLog.js";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("parseLatexLog", () => {
  it("attributes errors and warnings to the right file in an Overleaf-style log", () => {
    const log = parseLatexLog(fixture("pdflatex-errors.log"));
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toMatchObject({ message: "Undefined control sequence.", file: "sections/body.tex", line: 2 });
    expect(log.errors[0].context).toContain("l.2 \\undefinedcommand");
    expect(log.warnings.map((w) => [w.file, w.line, w.message.slice(0, 20)])).toEqual([
      ["main.tex", 4, "Reference `sec:missi"],
      ["main.tex", 4, "Citation `nokey' on "],
      ["main.tex", undefined, "There were undefined"],
      ["main.tex", undefined, "Label(s) may have ch"],
    ]);
    // The bad box comes after sections/body.tex was closed again.
    expect(log.typesetting).toEqual([
      expect.objectContaining({ file: "main.tex", line: 6, message: expect.stringContaining("Overfull \\hbox") }),
    ]);
    expect(log.pages).toBe(1);
  });

  it("handles -file-line-error logs", () => {
    const log = parseLatexLog(fixture("pdflatex-file-line-error.log"));
    expect(log.errors).toEqual([
      expect.objectContaining({ file: "sections/body.tex", line: 2, message: "Undefined control sequence." }),
    ]);
  });

  it("reports missing packages without the consequential emergency stop", () => {
    const log = parseLatexLog(fixture("pdflatex-missing-package.log"));
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0].message).toBe("LaTeX Error: File `doesnotexist.sty' not found.");
    expect(log.errors[0].file).toBe("fatal.tex");
    expect(log.errors[0].context).not.toContain("Type X to quit");
  });

  it("joins multi-line package warnings and unwraps 79-column lines", () => {
    const wrapped = "(./main.tex\nPackage hyperref Warning: Token not allowed in a PDF string (Unicode):\n(hyperref)                removing `math shift' on input line 30.\n\n";
    const label = "sec:".padEnd(50, "x");
    const long = `LaTeX Warning: Reference \`${label}' o`;
    expect(long.length).toBe(79);
    const log = parseLatexLog(`${wrapped}${long}\nn page 3 undefined on input line 12.\n\n)`);
    expect(log.warnings).toEqual([
      expect.objectContaining({
        file: "main.tex",
        line: 30,
        message: "hyperref: Token not allowed in a PDF string (Unicode): removing `math shift' on input line 30.",
      }),
      expect.objectContaining({ file: "main.tex", line: 12, message: expect.stringContaining("on page 3 undefined") }),
    ]);
  });

  it("strips build directory prefixes", () => {
    const log = parseLatexLog("/tmp/build/main.tex:3: Undefined control sequence.\nl.3 \\foo\n", {
      stripPrefixes: ["/tmp/build"],
    });
    expect(log.errors[0]).toMatchObject({ file: "main.tex", line: 3 });
  });
});

describe("parseBibLog", () => {
  it("parses BibTeX errors and warnings", () => {
    const bib = parseBibLog(fixture("bibtex.blg"));
    expect(bib.errors).toEqual([
      expect.objectContaining({ file: "refs.bib", line: 7, message: "I was expecting a `,' or a `}'" }),
    ]);
    expect(bib.warnings.map((w) => w.message)).toEqual([
      'I didn\'t find a database entry for "missingkey"',
      "empty journal in good",
    ]);
  });

  it("parses Biber messages", () => {
    const bib = parseBibLog(
      "[0] Config.pm:307> INFO - This is Biber 2.19\n[120] Utils.pm:410> WARN - I didn't find a database entry for 'foo' (section 0)\n[130] Biber.pm:120> ERROR - BibTeX subsystem: /tmp/refs.bib_1.utf8, line 4, syntax error: found \"}\"",
    );
    expect(bib.warnings).toHaveLength(1);
    expect(bib.errors).toHaveLength(1);
  });
});
