import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OverleafWeb, decodeSocketPayload } from "../src/overleafWeb.js";
import { extractZip } from "../src/transport.js";
import { FakeOverleafWeb } from "./fakeWeb.js";
import { SEED_FILES, connect, type Harness } from "./helpers.js";

const ID = "6600000000000000000000aa";

let tmp: string;
let site: FakeOverleafWeb;
let h: Harness;

function config(extra: Record<string, string> = {}) {
  // No OVERLEAF_GIT_TOKEN: a free Overleaf account.
  return loadConfig({ OVERLEAF_COOKIE: "good", TEXMEX_WORKDIR: path.join(tmp, "work"), ...extra });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "texmex-web-"));
  site = new FakeOverleafWeb(ID);
  for (const [file, text] of Object.entries(SEED_FILES)) site.set(file, text);
  h = await connect(config(), { fetch: site.fetch });
});

afterEach(async () => {
  await h.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("free accounts (session cookie, no Git token)", () => {
  it("downloads and reads a project by name", async () => {
    const list = await h.call("list_projects");
    expect(list.text).toContain(`"Free Paper" — id ${ID}, owner — not downloaded`);
    expect(list.text).not.toContain("OVERLEAF_GIT_TOKEN");

    const read = await h.call("read_file", { project: "free paper", path: "sections/intro.tex" });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("     2\tThis is the introduction.");
    const outline = await h.call("get_outline", { project: ID });
    expect(outline.text).toContain("Static check: no problems found.");
  });

  it("pushes edits, new nested files, binary files and deletions", async () => {
    const mainDocId = site.entityId("main.tex");
    await h.call("edit_file", { project: ID, path: "main.tex", old_string: "\\section{Method}", new_string: "\\section{Methods}" });
    await h.call("write_file", { project: ID, path: "chapters/new/results.tex", content: "Results.\n" });
    const png = path.join(tmp, "plot.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    await h.call("import_file", { project: ID, source_path: png, dest_path: "figures/plot.png" });
    await h.call("delete_file", { project: ID, path: "refs.bib" });

    const push = await h.call("push_changes", { project: ID, message: "Revise" });
    expect(push.isError).toBe(false);
    expect(push.text).toContain("Pushed 4 file(s) to Overleaf");

    expect(site.read("main.tex")).toContain("\\section{Methods}");
    expect(site.entityId("main.tex")).toBe(mainDocId); // replaced in place: Overleaf history is kept
    expect(site.read("chapters/new/results.tex")).toBe("Results.\n");
    expect(site.files().get("figures/plot.png")?.[0]).toBe(0x89);
    expect(site.entityId("figures/plot.png")).toMatch(/^file-/);
    expect(site.read("refs.bib")).toBeUndefined();
    expect(site.uploads.sort()).toEqual(["chapters/new/results.tex", "figures/plot.png", "main.tex"]);

    // What we pushed round-trips exactly: a fresh download changes nothing.
    const status = await h.call("get_status", { project: ID });
    expect(status.text).toContain("No local changes");
    const sync = await h.call("sync_project", { project: ID });
    expect(sync.text).toContain("Already up to date with Overleaf.");
    const again = await h.call("push_changes", { project: ID, message: "noop" });
    expect(again.text).toContain("Nothing to push");
  });

  it("merges edits made on Overleaf and stops on conflicts", async () => {
    await h.call("edit_file", { project: ID, path: "sections/intro.tex", old_string: "It has a second line.", new_string: "It has OUR second line." });
    site.set("main.tex", site.read("main.tex")!.replace("\\maketitle", "\\maketitle\n% added on Overleaf"));
    const push = await h.call("push_changes", { project: ID, message: "Intro" });
    expect(push.text).toContain("Pushed 1 file(s)");
    expect(push.text).toContain("Merged 1 change(s) from Overleaf first");
    expect(site.read("main.tex")).toContain("% added on Overleaf"); // not overwritten
    expect(site.read("sections/intro.tex")).toContain("OUR second line");

    await h.call("edit_file", { project: ID, path: "sections/intro.tex", old_string: "This is the introduction.", new_string: "Mine." });
    site.set("sections/intro.tex", site.read("sections/intro.tex")!.replace("This is the introduction.", "Theirs."));
    const conflict = await h.call("push_changes", { project: ID, message: "Clash" });
    expect(conflict.text).toContain("Nothing was pushed");
    expect(site.read("sections/intro.tex")).toContain("Theirs.");

    await h.call("write_file", {
      project: ID,
      path: "sections/intro.tex",
      content: "\\section{Introduction}\\label{sec:intro}\nMine and theirs.\nIt has OUR second line.\n",
    });
    const resolved = await h.call("push_changes", { project: ID, message: "Resolve" });
    expect(resolved.text).toContain("Pushed 1 file(s)");
    expect(site.read("sections/intro.tex")).toContain("Mine and theirs.");
  });

  it("removes folders that no longer contain files", async () => {
    site.set("old/a.tex", "a");
    site.set("old/deep/b.tex", "b");
    site.set("keep/c.tex", "c");
    await h.call("sync_project", { project: ID });
    await h.call("delete_file", { project: ID, path: "old", recursive: true });
    await h.call("delete_file", { project: ID, path: "keep/c.tex" });
    await h.call("write_file", { project: ID, path: "keep/d.tex", content: "d" });
    const push = await h.call("push_changes", { project: ID, message: "Tidy" });
    expect(push.isError).toBe(false);
    expect(site.folderExists("old")).toBe(false);
    expect(site.folderExists("keep")).toBe(true);
    expect(site.read("keep/d.tex")).toBe("d");
    expect(site.read("keep/c.tex")).toBeUndefined();
  });

  it("keeps local edits when Overleaf drops the real-time connection", async () => {
    await h.call("edit_file", { project: ID, path: "main.tex", old_string: "\\maketitle", new_string: "\\maketitle % mine" });
    site.rejectSocket = true;
    const push = await h.call("push_changes", { project: ID, message: "Edit" });
    expect(push.isError).toBe(true);
    expect(push.text).toContain("closed the real-time connection");
    expect(site.handshakes).toBe(2); // reconnected once, as the server advises
    expect(site.read("main.tex")).not.toContain("% mine");
    const status = await h.call("get_status", { project: ID });
    expect(status.text).toContain("M main.tex");

    site.rejectSocket = false;
    const retry = await h.call("push_changes", { project: ID, message: "Edit" });
    expect(retry.text).toContain("Pushed 1 file(s)");
    expect(site.read("main.tex")).toContain("% mine");
  });

  it("explains an expired cookie", async () => {
    const stale = await connect(config({ OVERLEAF_COOKIE: "stale", TEXMEX_WORKDIR: path.join(tmp, "w2") }), { fetch: site.fetch });
    const r = await stale.call("read_file", { project: ID, path: "main.tex" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("session cookie is invalid or has expired");
    await stale.close();
  });
});

describe("rate limiting", () => {
  it("waits and retries when Overleaf rate-limits downloads", async () => {
    const web = new OverleafWeb("https://www.overleaf.com", "overleaf_session2=good", site.fetch, [1, 1, 1]);
    site.rateLimitNext = 2;
    expect(extractZip(await web.downloadZip(ID)).has("main.tex")).toBe(true);
    site.rateLimitNext = 5;
    await expect(web.downloadZip(ID)).rejects.toThrow("10 project downloads per minute");
  });
});

describe("protocol helpers", () => {
  it("decodes framed socket.io 0.9 payloads", () => {
    const event = '5:::{"name":"x","args":["é ✓"]}';
    const framed = `\ufffd3\ufffd1::\ufffd${event.length}\ufffd${event}`;
    expect(decodeSocketPayload(framed)).toEqual([
      { type: "1", data: "" },
      { type: "5", data: '{"name":"x","args":["é ✓"]}' },
    ]);
    expect(decodeSocketPayload("8::")).toEqual([{ type: "8", data: "" }]);
  });

  it("ignores unsafe paths in downloaded zips", () => {
    const zip = zipSync({ "main.tex": new Uint8Array([65]), "../evil.tex": new Uint8Array([66]), ".git/config": new Uint8Array([67]) });
    expect([...extractZip(zip).keys()]).toEqual(["main.tex"]);
  });
});
