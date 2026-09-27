import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverleafWeb } from "../src/overleafWeb.js";
import { FakeOverleaf, PROJECT_ID, connect, type Harness } from "./helpers.js";

const LOG = fs.readFileSync(path.join(__dirname, "fixtures", "pdflatex-errors.log"), "utf8");
const OTHER_ID = "650000000000000000000abc";

interface Seen {
  method: string;
  url: URL;
  cookie: string | null;
  csrf: string | null;
}

function fakeWeb(opts: { validCookie?: string } = {}) {
  const seen: Seen[] = [];
  const valid = opts.validCookie ?? "overleaf_session2=good";
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    seen.push({ method, url, cookie: headers.get("cookie"), csrf: headers.get("x-csrf-token") });
    if (url.origin !== "https://www.overleaf.com") {
      return new Response("elsewhere", { status: 404 });
    }
    if (headers.get("cookie") !== valid) {
      return new Response(null, { status: 302, headers: { location: "/login?redir=%2Fproject" } });
    }
    if (url.pathname === "/user/projects") {
      return Response.json({
        projects: [
          { _id: PROJECT_ID, name: "My Thesis", accessLevel: "owner" },
          { _id: OTHER_ID, name: "Thesis notes", accessLevel: "readAndWrite" },
        ],
      });
    }
    if (url.pathname === "/project") {
      return new Response('<html><head><meta name="ol-csrfToken" content="tok&amp;123"></head></html>', {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === `/project/${PROJECT_ID}/compile` && method === "POST") {
      if (headers.get("x-csrf-token") !== "tok&123") return new Response("bad csrf", { status: 403 });
      const body = JSON.parse(String(init.body));
      expect(body.check).toBe("silent");
      const base = `/project/${PROJECT_ID}/user/u1/build/b-1/output`;
      return Response.json({
        status: "success",
        compileGroup: "standard",
        clsiServerId: "clsi-7",
        pdfDownloadDomain: "https://compiles.example.com",
        outputFiles: [
          { path: "output.pdf", url: `${base}/output.pdf`, type: "pdf", build: "b-1" },
          { path: "output.log", url: `${base}/output.log`, type: "log", build: "b-1" },
        ],
      });
    }
    if (url.pathname.endsWith("/output/output.log") && url.searchParams.get("clsiserverid") === "clsi-7") {
      return new Response(LOG);
    }
    if (url.pathname.endsWith("/output/output.pdf") && url.searchParams.get("compileGroup") === "standard") {
      return new Response("%PDF-1.5 fake");
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

let overleaf: FakeOverleaf;
let h: Harness;
let web: ReturnType<typeof fakeWeb>;

beforeEach(async () => {
  overleaf = new FakeOverleaf();
  overleaf.createProject();
  web = fakeWeb();
  h = await connect(overleaf.config({ OVERLEAF_COOKIE: "good" }), { fetch: web.fetchImpl });
});

afterEach(async () => {
  await h.close();
  overleaf.cleanup();
});

describe("with a session cookie", () => {
  it("lists the account's projects", async () => {
    const r = await h.call("list_projects");
    expect(r.text).toContain(`"My Thesis" — id ${PROJECT_ID}, owner — not downloaded`);
    expect(r.text).toContain(`"Thesis notes" — id ${OTHER_ID}, readAndWrite`);
  });

  it("resolves projects by exact or unique partial name", async () => {
    const exact = await h.call("read_file", { project: "my thesis", path: "main.tex" });
    expect(exact.isError).toBe(false);
    const partial = await h.call("get_status", { project: "My Th" });
    expect(partial.text).toContain(`"My Thesis" (${PROJECT_ID})`);
    const ambiguous = await h.call("get_status", { project: "thesis" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("matches several projects");
  });

  it("compiles on Overleaf and reports parsed errors", async () => {
    const r = await h.call("compile", { project: PROJECT_ID, where: "overleaf" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Compiled on Overleaf: PDF PRODUCED WITH ERRORS — 1 error(s), 4 warning(s)");
    expect(r.text).toContain("sections/body.tex:2 — Undefined control sequence.");
    expect(r.text).toContain("main.tex:4 — Citation `nokey' on page 1 undefined");
    const pdf = /PDF: (.*)/.exec(r.text)?.[1];
    expect(pdf && fs.readFileSync(pdf, "utf8")).toBe("%PDF-1.5 fake");

    const log = await h.call("get_compile_log", { project: PROJECT_ID, pattern: "undefined control" });
    expect(log.text).toContain("! Undefined control sequence.");
  });

  it("warns when compiling on Overleaf with unpushed changes", async () => {
    await h.call("write_file", { project: PROJECT_ID, path: "x.tex", content: "x" });
    const r = await h.call("compile", { project: PROJECT_ID, where: "overleaf" });
    expect(r.text).toContain("not pushed, so Overleaf compiled the last pushed version");
  });

  it("never sends the cookie to other origins", async () => {
    const client = new OverleafWeb("https://www.overleaf.com", "overleaf_session2=good", web.fetchImpl);
    const buf = await client.downloadOutput(
      { status: "success", pdfDownloadDomain: "https://compiles.example.com" },
      { path: "output.blg", url: "/project/x/build/1/output/output.blg" },
    );
    expect(buf).toBeUndefined();
    const foreign = web.seen.filter((s) => s.url.origin === "https://compiles.example.com");
    expect(foreign.length).toBeGreaterThan(0);
    expect(foreign.every((s) => s.cookie === null)).toBe(true);
  });
});

describe("with an expired cookie", () => {
  it("explains how to refresh it", async () => {
    const expired = await connect(overleaf.config({ OVERLEAF_COOKIE: "stale" }), { fetch: web.fetchImpl });
    const r = await expired.call("compile", { project: PROJECT_ID, where: "overleaf" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("session cookie is invalid or has expired");
    const list = await expired.call("list_projects");
    expect(list.text).toContain("Could not load projects from Overleaf");
    await expired.close();
  });
});
