import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject, detectMainFile, findIssues, stripComments } from "../src/outline.js";

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "texmex-outline-"));
  dirs.push(root);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("stripComments", () => {
  it("removes comments but keeps escaped percent signs and line count", () => {
    const out = stripComments("50\\% done % comment\n% whole line\n\\begin{verbatim}\n\\section{x}\n\\end{verbatim}\nafter");
    expect(out.split("\n")).toEqual(["50\\% done ", "", "\\begin{verbatim}", "", "", "after"]);
  });
});

describe("detectMainFile", () => {
  it("prefers main.tex and ignores subfiles", async () => {
    const root = project({
      "chapter.tex": "\\documentclass[main.tex]{subfiles}\n",
      "thesis.tex": "\\documentclass{report}\n",
      "main.tex": "% \\documentclass{article}\nno class here\n",
    });
    expect(await detectMainFile(root)).toBe("thesis.tex");
  });
});

describe("analyzeProject", () => {
  it("follows includes, imports and graphics paths", async () => {
    const root = project({
      "main.tex": [
        "\\documentclass{book}",
        "\\graphicspath{{figures/}}",
        "\\begin{document}",
        "\\chapter{One}\\label{ch:one}",
        "\\include{chapters/one}",
        "\\import{parts/}{two}",
        "\\input{missing}",
        "\\includegraphics[width=\\linewidth]{plot}",
        "\\cref{sec:a,sec:b}",
        "\\begin{thebibliography}{9}\\bibitem{k1} K.\\end{thebibliography}",
        "\\citep[p.~3]{k1,k2}",
        "\\end{document}",
      ].join("\n"),
      "chapters/one.tex": "\\section{A \\emph{nested} title}\n\\label{sec:a}\n",
      "parts/two.tex": "\\section*{Two}\\input{sub}\n",
      "parts/sub.tex": "\\subsection{Sub}\\label{sec:a}\n",
      "figures/plot.pdf": "%PDF",
    });
    const a = await analyzeProject(root, "main.tex");
    expect(a.files).toEqual(["main.tex", "chapters/one.tex", "parts/two.tex", "parts/sub.tex"]);
    expect(a.sections.map((s) => [s.command, s.title, s.label ?? null])).toEqual([
      ["chapter", "One", "ch:one"],
      ["section", "A \\emph{nested} title", "sec:a"],
      ["section", "Two", null],
      ["subsection", "Sub", "sec:a"],
    ]);
    expect(a.graphics[0].resolved).toBe("figures/plot.pdf");
    const issues = findIssues(a).map((i) => i.message);
    expect(issues).toContain("\\input{missing}: file not found");
    expect(issues).toContain("\\cref{sec:b}: no matching \\label");
    expect(issues).toContain("\\citep{k2}: key not found in bibliography");
    expect(issues.some((i) => i.startsWith('label "sec:a" is defined 2 times'))).toBe(true);
    expect(issues.some((i) => i.includes("{k1}"))).toBe(false);
  });
});
