import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandExists } from "../src/compile.js";
import { FakeOverleaf, PROJECT_ID, SEED_FILES, connect, type Harness } from "./helpers.js";

const hasLatexmk = await commandExists("latexmk");

describe.skipIf(!hasLatexmk)("local compile (latexmk)", () => {
  let overleaf: FakeOverleaf;
  let h: Harness;
  let marker: string;

  beforeEach(async () => {
    overleaf = new FakeOverleaf();
    marker = path.join(overleaf.root, "latexmkrc-was-executed");
    overleaf.createProject(PROJECT_ID, {
      ...SEED_FILES,
      "sections/intro.tex": "\\section{Introduction}\\label{sec:intro}\nBroken: \\undefinedmacro{here}.\n",
      // A collaborator could add this; it must not run on the user's machine.
      latexmkrc: `system("touch ${marker}");\n`,
    });
    h = await connect(overleaf.config());
  });

  afterEach(async () => {
    await h.close();
    overleaf.cleanup();
  });

  it("reports errors with locations, then succeeds once fixed", { timeout: 120_000 }, async () => {
    const broken = await h.call("compile", { project: PROJECT_ID });
    expect(broken.isError).toBe(false);
    expect(broken.text).toContain("Compiled locally (main.tex)");
    expect(broken.text).toContain("sections/intro.tex:2 — Undefined control sequence.");
    expect(fs.existsSync(marker)).toBe(false);

    await h.call("edit_file", {
      project: PROJECT_ID,
      path: "sections/intro.tex",
      old_string: "Broken: \\undefinedmacro{here}.",
      new_string: "Fixed.",
    });
    const fixed = await h.call("compile", { project: PROJECT_ID });
    expect(fixed.text).toContain("SUCCESS — 0 error(s)");
    // latexmk ran bibtex, so the citation resolved and no warnings remain.
    expect(fixed.text).toContain("0 warning(s)");
    const pdf = /PDF: (.*)/.exec(fixed.text)?.[1];
    expect(pdf && fs.readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-");

    const log = await h.call("get_compile_log", { project: PROJECT_ID, lines: 5 });
    expect(log.isError).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
