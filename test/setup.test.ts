import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { addCodexTimeouts, buildLaunchConfig, npxCacheRoot, runSetup, type SetupIO } from "../src/setup.js";
import { FakeOverleafWeb } from "./fakeWeb.js";
import { SEED_FILES, connect } from "./helpers.js";

const ID = "6600000000000000000000bb";
let tmp: string;
let site: FakeOverleafWeb;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "texmex-setup-"));
  site = new FakeOverleafWeb(ID);
  for (const [file, text] of Object.entries(SEED_FILES)) site.set(file, text);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeIO(answer: string, available = ["claude", "codex"]) {
  const calls: string[][] = [];
  const log: string[] = [];
  const io: SetupIO = {
    promptSecret: async () => answer,
    log: (l) => log.push(l),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return available.includes(cmd) ? { code: 0, output: "" } : { code: null, output: "" };
    },
  };
  return { io, calls, log };
}

describe("launch command", () => {
  it("uses the absolute Node binary and passes PATH, so nvm installs work", () => {
    const launch = buildLaunchConfig({
      nodePath: "/home/u/.nvm/versions/node/v24.1.0/bin/node",
      entry: "/home/u/.texmex/app/node_modules/texmex-mcp/dist/index.js",
      cookieFile: "/home/u/.texmex/cookie",
      pathEnv: "/usr/bin:/bin:/usr/bin",
    });
    expect(launch.command).toBe("/home/u/.nvm/versions/node/v24.1.0/bin/node");
    expect(launch.args).toEqual(["/home/u/.texmex/app/node_modules/texmex-mcp/dist/index.js"]);
    expect(launch.env.PATH).toBe("/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin");
    expect(launch.env.OVERLEAF_COOKIE_FILE).toBe("/home/u/.texmex/cookie");
    expect(JSON.stringify(launch)).not.toContain("overleaf_session2");
  });

  it("recognises npx's cache", () => {
    expect(npxCacheRoot("/home/u/.npm/_npx/abc123/node_modules/texmex-mcp")).toBe("/home/u/.npm/_npx/abc123");
    expect(npxCacheRoot("/home/u/src/TexMex")).toBeUndefined();
  });

  it("adds Codex timeouts once, inside the server's table", () => {
    const toml = '[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.overleaf]\ncommand = "node"\n\n[mcp_servers.overleaf.env]\nA = "1"\n';
    const once = addCodexTimeouts(toml);
    expect(once).toContain('[mcp_servers.overleaf]\nstartup_timeout_sec = 30\ntool_timeout_sec = 300\ncommand = "node"');
    expect(addCodexTimeouts(once)).toBe(once);
    expect(once.indexOf("tool_timeout_sec")).toBeLessThan(once.indexOf("[mcp_servers.overleaf.env]"));
  });
});

describe("runSetup", () => {
  const options = (packageRoot: string) => ({
    clients: ["claude", "codex"] as Array<"claude" | "codex">,
    scope: "user" as const,
    packageRoot,
    nodePath: "/opt/node/bin/node",
    pathEnv: "/usr/bin:/bin",
    fetch: site.fetch,
    codexHome: path.join(tmp, "codex"),
  });

  it("validates and saves the cookie privately, then registers both clients", async () => {
    const config = loadConfig({ TEXMEX_WORKDIR: path.join(tmp, "work") });
    const { io, calls, log } = fakeIO("good");
    expect(await runSetup(config, options("/src/TexMex"), io)).toBe(0);

    const cookieFile = path.join(tmp, "work", "cookie");
    expect(fs.readFileSync(cookieFile, "utf8").trim()).toBe("overleaf_session2=good");
    if (process.platform !== "win32") expect(fs.statSync(cookieFile).mode & 0o777).toBe(0o600);
    expect(log.join("\n")).toContain("1 project(s) in your account");

    const addJson = calls.find((c) => c[0] === "claude" && c[2] === "add-json")!;
    expect(addJson.slice(0, 6)).toEqual(["claude", "mcp", "add-json", "-s", "user", "overleaf"]);
    const server = JSON.parse(addJson[6]);
    expect(server).toMatchObject({ type: "stdio", command: "/opt/node/bin/node", args: ["/src/TexMex/dist/index.js"] });
    expect(server.env.OVERLEAF_COOKIE_FILE).toBe(cookieFile);
    expect(addJson[6]).not.toContain("good"); // the secret never goes into the client config

    const codexAdd = calls.find((c) => c[0] === "codex" && c[2] === "add")!;
    expect(codexAdd).toContain(`OVERLEAF_COOKIE_FILE=${cookieFile}`);
    expect(codexAdd.slice(codexAdd.indexOf("--") + 1)).toEqual(["/opt/node/bin/node", "/src/TexMex/dist/index.js"]);
  });

  it("refuses an invalid cookie and saves nothing", async () => {
    const config = loadConfig({ TEXMEX_WORKDIR: path.join(tmp, "work") });
    const { io, calls, log } = fakeIO("expired");
    expect(await runSetup(config, options("/src/TexMex"), io)).toBe(1);
    expect(log.join("\n")).toContain("invalid or has expired");
    expect(fs.existsSync(path.join(tmp, "work", "cookie"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("copies TexMex out of npx's cache and prints manual steps when no client is installed", async () => {
    const npxRoot = path.join(tmp, "npm", "_npx", "abc");
    const pkg = path.join(npxRoot, "node_modules", "texmex-mcp");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "dist", "index.js"), "// server");
    fs.mkdirSync(path.join(npxRoot, "node_modules", "zod"), { recursive: true });
    const config = loadConfig({ TEXMEX_WORKDIR: path.join(tmp, "work") });
    const { io, log } = fakeIO("good", []);
    expect(await runSetup(config, options(pkg), io)).toBe(0);
    const installed = path.join(tmp, "work", "app", "node_modules", "texmex-mcp", "dist", "index.js");
    expect(fs.readFileSync(installed, "utf8")).toBe("// server");
    expect(fs.existsSync(path.join(tmp, "work", "app", "node_modules", "zod"))).toBe(true);
    expect(log.join("\n")).toContain('"command": "/opt/node/bin/node"');
    expect(log.join("\n")).toContain(installed);
  });

  it("keeps the saved cookie when Enter is pressed", async () => {
    fs.mkdirSync(path.join(tmp, "work"));
    fs.writeFileSync(path.join(tmp, "work", "cookie"), "good\n");
    const config = loadConfig({ TEXMEX_WORKDIR: path.join(tmp, "work") });
    const { io } = fakeIO("");
    expect(await runSetup(config, options("/src/TexMex"), io)).toBe(0);
    expect(fs.readFileSync(path.join(tmp, "work", "cookie"), "utf8").trim()).toBe("overleaf_session2=good");
  });
});

describe("cookie file", () => {
  it("is picked up automatically and re-read when it changes", async () => {
    const work = path.join(tmp, "work");
    fs.mkdirSync(work);
    const cookieFile = path.join(work, "cookie");
    fs.writeFileSync(cookieFile, "stale\n");
    const h = await connect(loadConfig({ TEXMEX_WORKDIR: work }), { fetch: site.fetch });
    const before = await h.call("list_projects");
    expect(before.text).toContain("session cookie is invalid or has expired");

    // The user refreshes their login (e.g. by re-running setup); no restart needed.
    fs.writeFileSync(cookieFile, "good\n");
    fs.utimesSync(cookieFile, new Date(), new Date(Date.now() + 5000));
    const after = await h.call("list_projects");
    expect(after.text).toContain(`"Free Paper" — id ${ID}`);
    await h.close();
  });

  it("reports an unreadable OVERLEAF_COOKIE_FILE", async () => {
    const config = loadConfig({ TEXMEX_WORKDIR: tmp, OVERLEAF_COOKIE_FILE: path.join(tmp, "missing") });
    expect(config.credentialWarnings[0]).toContain("Cannot read OVERLEAF_COOKIE_FILE");
    const h = await connect(config, { fetch: site.fetch });
    const r = await h.call("list_projects");
    expect(r.text).toContain("Cannot read");
    await h.close();
  });
});
