import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeOverleaf, PROJECT_ID, connect, git, type Harness } from "./helpers.js";

let overleaf: FakeOverleaf;
let h: Harness;

beforeEach(async () => {
  overleaf = new FakeOverleaf();
  overleaf.createProject();
  h = await connect(overleaf.config({ OVERLEAF_PROJECTS: `paper=${PROJECT_ID}` }));
});

afterEach(async () => {
  await h.close();
  overleaf.cleanup();
});

describe("tool registration", () => {
  it("exposes the read and write tools", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["list_projects", "read_file", "edit_file", "push_changes", "compile", "get_outline"]) {
      expect(names).toContain(n);
    }
  });

  it("hides write tools in read-only mode", async () => {
    const ro = await connect(overleaf.config({ TEXMEX_READ_ONLY: "true" }));
    const names = (await ro.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("push_changes");
    expect(names).not.toContain("write_file");
    await ro.close();
  });
});

describe("reading", () => {
  it("lists configured projects", async () => {
    const r = await h.call("list_projects");
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"paper"');
    expect(r.text).toContain(PROJECT_ID);
  });

  it("clones on first use and reads files with line numbers", async () => {
    const r = await h.call("read_file", { project: "paper", path: "sections/intro.tex" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Downloaded the project");
    expect(r.text).toContain("     2\tThis is the introduction.");
    const page = await h.call("read_file", { project: PROJECT_ID, path: "main.tex", offset: 3, limit: 2 });
    expect(page.text).toContain("lines 3-4 of 11");
    expect(page.text).toContain("     3\t\\begin{document}");
    expect(page.text).not.toContain("\\maketitle\n     5");
  });

  it("accepts project URLs", async () => {
    const r = await h.call("list_files", { project: `https://www.overleaf.com/project/${PROJECT_ID}` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("main.tex");
    expect(r.text).toContain("[main document]");
    expect(r.text).toContain("sections/intro.tex");
  });

  it("refuses paths outside the project", async () => {
    for (const p of ["../../etc/passwd", ".git/config", "/../x"]) {
      const r = await h.call("read_file", { project: "paper", path: p });
      expect(r.isError).toBe(true);
    }
  });

  it("reports unknown projects helpfully", async () => {
    const r = await h.call("read_file", { project: "nonexistent thing", path: "main.tex" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown project");
  });

  it("searches with context and globs", async () => {
    const r = await h.call("search_project", { project: "paper", pattern: "\\\\(ref|cite)\\{", regex: true, glob: "*.tex" });
    expect(r.text).toContain("2 match(es) in 1 file(s)");
    expect(r.text).toContain("main.tex:7:");
    const none = await h.call("search_project", { project: "paper", pattern: "knuth84", glob: "*.bib" });
    expect(none.text).toContain("refs.bib:1:");
  });

  it("builds an outline with static checks", async () => {
    await h.call("edit_file", {
      project: "paper",
      path: "main.tex",
      old_string: "See Section~\\ref{sec:intro}.",
      new_string: "See Section~\\ref{sec:intro} and \\ref{fig:missing}, \\cite{nobody99}.\n\\includegraphics{figs/plot}",
    });
    const r = await h.call("get_outline", { project: "paper" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Main file: main.tex");
    expect(r.text).toContain("Title: A Test Paper");
    expect(r.text).toMatch(/section: Introduction {2}\[sec:intro\] {2}— sections\/intro\.tex:1/);
    expect(r.text).toMatch(/section: Method {2}\[sec:method\] {2}— main\.tex:6/);
    expect(r.text).toContain("\\ref{fig:missing}: no matching \\label");
    expect(r.text).toContain("\\cite{nobody99}: key not found");
    expect(r.text).toContain("\\includegraphics{figs/plot}: image not found");
    expect(r.text).not.toContain("knuth84}: key not found");
  });
});

describe("editing and pushing", () => {
  it("edits locally, shows status/diff, and pushes to Overleaf", async () => {
    const edit = await h.call("edit_file", {
      project: "paper",
      path: "sections/intro.tex",
      old_string: "This is the introduction.",
      new_string: "This is the improved introduction.",
    });
    expect(edit.isError).toBe(false);
    expect(edit.text).toContain("replaced 1 occurrence");
    expect(edit.text).toContain("This is the improved introduction.");

    await h.call("write_file", { project: "paper", path: "sections/new.tex", content: "New section.\n" });
    await h.call("delete_file", { project: "paper", path: "refs.bib" });

    const status = await h.call("get_status", { project: "paper" });
    expect(status.text).toContain("3 local change(s) not yet pushed");
    expect(status.text).toContain("M sections/intro.tex");
    expect(status.text).toContain("A sections/new.tex");
    expect(status.text).toContain("D refs.bib");

    const diff = await h.call("get_diff", { project: "paper" });
    expect(diff.text).toContain("-This is the introduction.");
    expect(diff.text).toContain("+This is the improved introduction.");
    expect(diff.text).toContain("+New section.");

    // Nothing reached Overleaf yet.
    expect(overleaf.read(PROJECT_ID, "sections/intro.tex")).toContain("This is the introduction.");

    const push = await h.call("push_changes", { project: "paper", message: "Improve intro" });
    expect(push.isError).toBe(false);
    expect(push.text).toContain("Pushed 3 file(s) to Overleaf");
    expect(overleaf.read(PROJECT_ID, "sections/intro.tex")).toContain("improved introduction");
    expect(overleaf.read(PROJECT_ID, "sections/new.tex")).toBe("New section.\n");
    expect(() => overleaf.read(PROJECT_ID, "refs.bib")).toThrow();

    const after = await h.call("get_status", { project: "paper" });
    expect(after.text).toContain("No local changes");
    const again = await h.call("push_changes", { project: "paper", message: "noop" });
    expect(again.text).toContain("Nothing to push");

    const history = await h.call("get_history", { project: "paper", limit: 2 });
    expect(history.text).toContain('"Improve intro"');
    expect(history.text).toContain("M sections/intro.tex");
  });

  it("rejects ambiguous or missing edits with guidance", async () => {
    const dup = await h.call("edit_file", { project: "paper", path: "main.tex", old_string: "{document}", new_string: "{document}%" });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("occurs 2 times in main.tex (lines 3, 11)");
    expect(dup.text).toContain("Include more surrounding text");
    const missing = await h.call("edit_file", {
      project: "paper",
      path: "main.tex",
      old_string: "     3\t\\begin{document}",
      new_string: "x",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("line-number prefixes");
    const all = await h.call("edit_file", {
      project: "paper",
      path: "main.tex",
      old_string: "{document}",
      new_string: "{document}%",
      replace_all: true,
    });
    expect(all.isError).toBe(false);
    expect(all.text).toContain("replaced 2 occurrence(s)");
  });

  it("moves, imports and discards files", async () => {
    const moved = await h.call("move_file", { project: "paper", from: "refs.bib", to: "bib/refs.bib" });
    expect(moved.isError).toBe(false);
    const src = path.join(overleaf.root, "plot.png");
    fs.writeFileSync(src, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const imported = await h.call("import_file", { project: "paper", source_path: src, dest_path: "figs/plot.png" });
    expect(imported.isError).toBe(false);

    const status = await h.call("get_status", { project: "paper" });
    expect(status.text).toContain("figs/plot.png");

    const partial = await h.call("discard_changes", { project: "paper", paths: ["figs"] });
    expect(partial.text).toContain("figs/plot.png");
    const all = await h.call("discard_changes", { project: "paper", all: true });
    expect(all.isError).toBe(false);
    const clean = await h.call("get_status", { project: "paper" });
    expect(clean.text).toContain("No local changes");
    const list = await h.call("list_files", { project: "paper" });
    expect(list.text).toContain("refs.bib");
    expect(list.text).not.toContain("bib/refs.bib");
  });
});

describe("collaboration", () => {
  it("merges collaborators' changes into pending local edits", async () => {
    await h.call("edit_file", {
      project: "paper",
      path: "sections/intro.tex",
      old_string: "It has a second line.",
      new_string: "It has an edited second line.",
    });
    overleaf.commit(PROJECT_ID, { "main.tex": overleaf.read(PROJECT_ID, "main.tex").replace("Method", "Methods") });

    const sync = await h.call("sync_project", { project: "paper" });
    expect(sync.isError).toBe(false);
    expect(sync.text).toContain("Pulled 1 changed file(s)");
    expect(sync.text).toContain("M main.tex");
    expect(sync.text).toContain("1 local change(s) not yet pushed");

    const main = await h.call("read_file", { project: "paper", path: "main.tex" });
    expect(main.text).toContain("\\section{Methods}");
    const status = await h.call("get_status", { project: "paper" });
    expect(status.text).toContain("M sections/intro.tex");
    expect(status.text).not.toContain("M main.tex");

    const push = await h.call("push_changes", { project: "paper", message: "Edit intro" });
    expect(push.text).toContain("Pushed 1 file(s)");
    expect(overleaf.read(PROJECT_ID, "main.tex")).toContain("Methods");
    expect(overleaf.read(PROJECT_ID, "sections/intro.tex")).toContain("edited second line");
  });

  it("push merges newer Overleaf changes automatically", async () => {
    await h.call("read_file", { project: "paper", path: "main.tex" });
    await h.call("write_file", { project: "paper", path: "notes.tex", content: "notes\n" });
    overleaf.commit(PROJECT_ID, { "refs.bib": `${overleaf.read(PROJECT_ID, "refs.bib")}\n@misc{extra, title={X}}\n` });
    const push = await h.call("push_changes", { project: "paper", message: "Add notes" });
    expect(push.isError).toBe(false);
    expect(push.text).toContain("Pushed 1 file(s)");
    expect(push.text).toContain("Merged 1 change(s) from Overleaf first");
    expect(overleaf.read(PROJECT_ID, "refs.bib")).toContain("@misc{extra");
    expect(overleaf.read(PROJECT_ID, "notes.tex")).toBe("notes\n");
  });

  it("stops on conflicts, then pushes the resolved version", async () => {
    await h.call("edit_file", {
      project: "paper",
      path: "sections/intro.tex",
      old_string: "This is the introduction.",
      new_string: "This is OUR introduction.",
    });
    await h.call("write_file", { project: "paper", path: "extra.tex", content: "extra\n" });
    overleaf.commit(PROJECT_ID, {
      "sections/intro.tex": overleaf.read(PROJECT_ID, "sections/intro.tex").replace("This is the introduction.", "This is THEIR introduction."),
    });

    const push = await h.call("push_changes", { project: "paper", message: "Mine" });
    expect(push.text).toContain("Nothing was pushed");
    expect(push.text).toContain("Changed on Overleaf since your last sync:\n  M sections/intro.tex");
    expect(push.text).not.toContain("Merged");
    expect(push.text).toContain("sections/intro.tex");
    expect(overleaf.read(PROJECT_ID, "sections/intro.tex")).toContain("THEIR");

    const conflicted = await h.call("read_file", { project: "paper", path: "sections/intro.tex" });
    expect(conflicted.text).toContain("<<<<<<<");
    const status = await h.call("get_status", { project: "paper" });
    expect(status.text).toContain("Merge in progress with 1 conflicted file(s): sections/intro.tex");
    expect(status.text).toContain("U sections/intro.tex");
    expect(status.text).toContain("A extra.tex"); // other pending edits stay visible
    expect(status.text).not.toContain("newer commit");
    const diff = await h.call("get_diff", { project: "paper" });
    expect(diff.text).toContain("+This is OUR introduction."); // compared with Overleaf's version
    expect(diff.text).toContain(" This is THEIR introduction.");
    expect(diff.text).toContain("+extra");

    // Pushing again without resolving is refused.
    const retry = await h.call("push_changes", { project: "paper", message: "Mine" });
    expect(retry.text).toContain("Nothing was pushed");

    await h.call("write_file", {
      project: "paper",
      path: "sections/intro.tex",
      content: "\\section{Introduction}\\label{sec:intro}\nThis is OUR and THEIR introduction.\nIt has a second line.\n",
    });
    const ready = await h.call("get_status", { project: "paper" });
    expect(ready.text).toContain("conflicts look resolved");
    expect(ready.text).toContain("M sections/intro.tex");
    const resolved = await h.call("push_changes", { project: "paper", message: "Merge intros" });
    expect(resolved.isError).toBe(false);
    expect(resolved.text).toContain("Pushed 2 file(s)");
    expect(overleaf.read(PROJECT_ID, "sections/intro.tex")).toContain("OUR and THEIR");
    expect(overleaf.read(PROJECT_ID, "extra.tex")).toBe("extra\n");
    const clean = await h.call("get_status", { project: "paper" });
    expect(clean.text).toContain("No local changes");
    expect(clean.text).not.toContain("Merge in progress");
  });

  it("discard all aborts a conflicted merge", async () => {
    await h.call("edit_file", { project: "paper", path: "main.tex", old_string: "\\maketitle", new_string: "\\maketitle % ours" });
    overleaf.commit(PROJECT_ID, { "main.tex": overleaf.read(PROJECT_ID, "main.tex").replace("\\maketitle", "\\maketitle % theirs") });
    const sync = await h.call("sync_project", { project: "paper" });
    expect(sync.text).toContain("conflict");
    const discard = await h.call("discard_changes", { project: "paper", all: true });
    expect(discard.isError).toBe(false);
    const main = await h.call("read_file", { project: "paper", path: "main.tex" });
    expect(main.text).toContain("% theirs");
    expect(main.text).not.toContain("<<<<<<<");
  });

  it("auto-syncs stale working copies before reading", async () => {
    await h.call("read_file", { project: "paper", path: "main.tex" });
    overleaf.commit(PROJECT_ID, { "sections/intro.tex": "\\section{Introduction}\\label{sec:intro}\nRewritten on Overleaf.\n" });
    h.texmex.workspace(PROJECT_ID).lastFetch = 0; // pretend the last fetch was long ago
    const r = await h.call("read_file", { project: "paper", path: "sections/intro.tex" });
    expect(r.text).toContain("Pulled 1 updated file(s) from Overleaf");
    expect(r.text).toContain("Rewritten on Overleaf.");
  });

  it("recovers edits left in a stray local commit", async () => {
    await h.call("write_file", { project: "paper", path: "stray.tex", content: "stray\n" });
    const dir = path.join(overleaf.workdir, "projects", PROJECT_ID);
    // e.g. a push that timed out after committing, or a manual `git commit`
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "manual");
    const status = await h.call("get_status", { project: "paper" });
    expect(status.text).toContain("A stray.tex");
    const push = await h.call("push_changes", { project: "paper", message: "Recovered" });
    expect(push.text).toContain("Pushed 1 file(s)");
    expect(overleaf.read(PROJECT_ID, "stray.tex")).toBe("stray\n");
  });
});
