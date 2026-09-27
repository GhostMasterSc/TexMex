import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeOverleaf, PROJECT_ID, connect } from "./helpers.js";

const TOKEN = "olp_TestToken1234567890";
const backend = path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git-http-backend");

/**
 * A smart-HTTP git server (git http-backend behind Basic auth), standing in for
 * git.overleaf.com: username "git", password = the Git token.
 */
function startGitServer(projectRoot: string, seenAuth: string[]): Promise<http.Server> {
  const expected = `Basic ${Buffer.from(`git:${TOKEN}`).toString("base64")}`;
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    seenAuth.push(auth);
    if (auth !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Overleaf"' });
      res.end("Unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const cgi = spawn(backend, [], {
      env: {
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "git",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.receivepack",
        GIT_CONFIG_VALUE_0: "true",
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (c: Buffer) => chunks.push(c));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const sep = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, sep).toString();
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(sep + 4));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("Git token authentication over HTTP", () => {
  let overleaf: FakeOverleaf;
  let server: http.Server;
  let gitUrl: string;
  const seenAuth: string[] = [];

  beforeAll(async () => {
    overleaf = new FakeOverleaf();
    overleaf.createProject();
    server = await startGitServer(overleaf.remotes, seenAuth);
    gitUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    overleaf.cleanup();
  });

  it("clones and pushes with the token without storing it on disk", async () => {
    const h = await connect(overleaf.config({ OVERLEAF_GIT_URL: gitUrl, OVERLEAF_GIT_TOKEN: TOKEN }));
    const read = await h.call("read_file", { project: PROJECT_ID, path: "main.tex" });
    expect(read.isError).toBe(false);
    await h.call("write_file", { project: PROJECT_ID, path: "added.tex", content: "hello\n" });
    const push = await h.call("push_changes", { project: PROJECT_ID, message: "via http" });
    expect(push.text).toContain("Pushed 1 file(s)");
    expect(overleaf.read(PROJECT_ID, "added.tex")).toBe("hello\n");

    // The token must not end up in the working copy's git config or remote URL.
    const gitDir = path.join(overleaf.workdir, "projects", PROJECT_ID, ".git");
    const config = fs.readFileSync(path.join(gitDir, "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(Buffer.from(`git:${TOKEN}`).toString("base64"));
    expect(config).toContain(`url = ${gitUrl}/${PROJECT_ID}`);
    expect(seenAuth.some((a) => a.startsWith("Basic "))).toBe(true);
    await h.close();
  });

  it("explains a missing or wrong token", async () => {
    const missing = await connect(
      overleaf.config({ OVERLEAF_GIT_URL: gitUrl, TEXMEX_WORKDIR: path.join(overleaf.root, "w2") }),
    );
    const r1 = await missing.call("read_file", { project: PROJECT_ID, path: "main.tex" });
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain("No Overleaf credentials are configured");
    await missing.close();

    const wrong = await connect(
      overleaf.config({ OVERLEAF_GIT_URL: gitUrl, OVERLEAF_GIT_TOKEN: "olp_wrong", TEXMEX_WORKDIR: path.join(overleaf.root, "w3") }),
    );
    const r2 = await wrong.call("read_file", { project: PROJECT_ID, path: "main.tex" });
    expect(r2.isError).toBe(true);
    expect(r2.text).toContain("Overleaf rejected the Git token");
    expect(r2.text).not.toContain("olp_wrong");
    await wrong.close();
  });
});
