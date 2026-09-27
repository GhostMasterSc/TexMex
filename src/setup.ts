import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCookieFile, normalizeCookie, type Config } from "./config.js";
import { errorMessage } from "./errors.js";
import { OverleafWeb } from "./overleafWeb.js";

export interface LaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SetupIO {
  /** Ask for a secret without echoing it. */
  promptSecret(question: string): Promise<string>;
  log(line: string): void;
  /** Run a CLI (claude/codex). Resolves with the exit code and output; ENOENT → code null. */
  run(cmd: string, args: string[]): Promise<{ code: number | null; output: string }>;
}

export interface SetupOptions {
  clients: Array<"claude" | "codex">;
  /** Claude Code scope. */
  scope: "user" | "local" | "project";
  /** Where the running TexMex package lives (…/dist/.. ). */
  packageRoot: string;
  nodePath: string;
  pathEnv: string;
  fetch?: typeof fetch;
  codexHome?: string;
}

const SERVER_NAME = "overleaf";

/**
 * If TexMex runs from npx's cache (…/_npx/<hash>/node_modules/texmex-mcp), return
 * that cache folder: it holds TexMex and its dependencies, ready to copy.
 */
export function npxCacheRoot(packageRoot: string): string | undefined {
  const parts = path.resolve(packageRoot).split(path.sep);
  const i = parts.lastIndexOf("_npx");
  return i >= 0 && parts.length > i + 1 ? parts.slice(0, i + 2).join(path.sep) : undefined;
}

/**
 * The command MCP clients should run. It uses the absolute path of the Node
 * binary, so it works even when the client's PATH does not contain Node (as
 * with nvm/fnm/volta or a client started before Node was installed), and passes
 * this terminal's PATH so git and latexmk resolve the same way they do here.
 */
export function buildLaunchConfig(opts: {
  nodePath: string;
  entry: string;
  cookieFile: string;
  pathEnv: string;
  workdir?: string;
}): LaunchConfig {
  const nodeDir = path.dirname(opts.nodePath);
  const pathParts = [nodeDir, ...opts.pathEnv.split(path.delimiter)].filter(Boolean);
  const env: Record<string, string> = {
    OVERLEAF_COOKIE_FILE: opts.cookieFile,
    PATH: [...new Set(pathParts)].join(path.delimiter),
  };
  if (opts.workdir) env.TEXMEX_WORKDIR = opts.workdir;
  return { command: opts.nodePath, args: [opts.entry], env };
}

/** Copy TexMex out of npx's cache into a stable folder so it starts fast and offline. */
async function installStableCopy(npxRoot: string, workdir: string): Promise<string> {
  const appDir = path.join(workdir, "app");
  const staging = `${appDir}.new`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(npxRoot, staging, { recursive: true, verbatimSymlinks: true });
  await fs.rm(appDir, { recursive: true, force: true });
  await fs.rename(staging, appDir);
  return path.join(appDir, "node_modules", "texmex-mcp", "dist", "index.js");
}

/** Add request/tool timeouts to Codex's config (its 60 s tool default is short for compiles). */
export function addCodexTimeouts(toml: string): string {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return toml;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end);
  const additions = [
    ...(section.some((l) => /^\s*startup_timeout_sec\s*=/.test(l)) ? [] : ["startup_timeout_sec = 30"]),
    ...(section.some((l) => /^\s*tool_timeout_sec\s*=/.test(l)) ? [] : ["tool_timeout_sec = 300"]),
  ];
  lines.splice(start + 1, 0, ...additions);
  return lines.join("\n");
}

function manualInstructions(launch: LaunchConfig): string {
  const json = JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: launch.command, args: launch.args, env: launch.env } } }, null, 2);
  const tomlEnv = Object.entries(launch.env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ");
  return [
    "Add this to your MCP client's configuration:",
    "",
    "Claude Desktop / .mcp.json:",
    json,
    "",
    "Codex (~/.codex/config.toml):",
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(launch.command)}`,
    `args = ${JSON.stringify(launch.args)}`,
    `env = { ${tomlEnv} }`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 300",
  ].join("\n");
}

export async function runSetup(config: Config, opts: SetupOptions, io: SetupIO): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    io.log(`✗ TexMex needs Node.js 20 or newer (this is ${process.version}).`);
    return 1;
  }

  // 1. Overleaf login
  io.log("1. Overleaf login");
  const cookieFile = config.cookieFile ?? defaultCookieFile(config.workdir);
  let existing: string | undefined;
  try {
    existing = normalizeCookie(await fs.readFile(cookieFile, "utf8"));
  } catch {
    // no saved login yet
  }
  io.log("   Log in to overleaf.com in your browser, press F12 → Application (Firefox: Storage) → Cookies →");
  io.log("   https://www.overleaf.com, and copy the value of overleaf_session2.");
  const answer = await io.promptSecret(
    existing ? "   Paste the cookie value (input hidden; press Enter to keep the saved one): " : "   Paste the cookie value (input hidden): ",
  );
  const cookie = normalizeCookie(answer) ?? existing;
  if (!cookie) {
    io.log("   ✗ No cookie given.");
    return 1;
  }
  if (answer.trim()) io.log(`   (received ${answer.trim().length} characters)`);
  try {
    const projects = await new OverleafWeb(config.webBaseUrl, cookie, opts.fetch).listProjects({ refresh: true });
    io.log(`   ✓ Logged in to Overleaf: ${projects.length} project(s) in your account.`);
  } catch (err) {
    io.log(`   ✗ ${errorMessage(err)}`);
    return 1;
  }
  await fs.mkdir(path.dirname(cookieFile), { recursive: true });
  await fs.writeFile(cookieFile, `${cookie}\n`, { mode: 0o600 });
  await fs.chmod(cookieFile, 0o600);
  io.log(`   ✓ Saved to ${cookieFile} (readable only by you; never written into MCP configs).`);

  // 2. Install location
  io.log("2. Install");
  let entry = path.join(opts.packageRoot, "dist", "index.js");
  const npxRoot = npxCacheRoot(opts.packageRoot);
  if (npxRoot) {
    entry = await installStableCopy(npxRoot, config.workdir);
    io.log(`   ✓ Installed TexMex to ${path.join(config.workdir, "app")}`);
  } else {
    io.log(`   ✓ Using TexMex from ${opts.packageRoot}`);
  }
  const launch = buildLaunchConfig({
    nodePath: opts.nodePath,
    entry,
    cookieFile,
    pathEnv: opts.pathEnv,
    workdir: process.env.TEXMEX_WORKDIR ? config.workdir : undefined,
  });
  io.log(`   Command: ${launch.command} ${launch.args.join(" ")}`);

  // 3. Register with the agents
  io.log("3. Connect");
  let registered = 0;
  if (opts.clients.includes("claude")) {
    await io.run("claude", ["mcp", "remove", SERVER_NAME, "-s", opts.scope]);
    const json = JSON.stringify({ type: "stdio", command: launch.command, args: launch.args, env: launch.env });
    const add = await io.run("claude", ["mcp", "add-json", "-s", opts.scope, SERVER_NAME, json]);
    if (add.code === null) io.log("   – Claude Code: `claude` command not found, skipped.");
    else if (add.code === 0) {
      io.log(`   ✓ Claude Code: registered "${SERVER_NAME}" (${opts.scope} scope).`);
      registered++;
    } else io.log(`   ✗ Claude Code: ${add.output.trim().split("\n").slice(-3).join(" ")}`);
  }
  if (opts.clients.includes("codex")) {
    await io.run("codex", ["mcp", "remove", SERVER_NAME]);
    const envArgs = Object.entries(launch.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const add = await io.run("codex", ["mcp", "add", SERVER_NAME, ...envArgs, "--", launch.command, ...launch.args]);
    if (add.code === null) io.log("   – Codex: `codex` command not found, skipped.");
    else if (add.code === 0) {
      registered++;
      const tomlPath = path.join(opts.codexHome ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".codex"), "config.toml");
      try {
        const toml = await fs.readFile(tomlPath, "utf8");
        await fs.writeFile(tomlPath, addCodexTimeouts(toml));
      } catch {
        // timeouts are a nicety
      }
      io.log(`   ✓ Codex: registered "${SERVER_NAME}".`);
    } else io.log(`   ✗ Codex: ${add.output.trim().split("\n").slice(-3).join(" ")}`);
  }

  io.log("");
  if (!registered) {
    io.log(manualInstructions(launch));
    return 0;
  }
  io.log("Done. Restart Claude Code / Codex (or run /mcp in Claude Code), then ask: \"List my Overleaf projects\".");
  io.log("When your Overleaf login expires, run this setup again: it only updates the saved cookie.");
  return 0;
}

// ------------------------------------------------------------------ terminal I/O

async function promptSecretTTY(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    // Piped input (e.g. `echo "$COOKIE" | texmex-mcp setup`): read one line.
    stdout.write(question);
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(chunk as Buffer);
      if (Buffer.concat(chunks).includes(10)) break;
    }
    stdout.write("\n");
    return Buffer.concat(chunks).toString("utf8").split("\n")[0].trim();
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (fn: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function runCli(cmd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // Windows installs these CLIs as .cmd shims, which need a shell.
    const windows = process.platform === "win32";
    const quoted = windows ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`) : args;
    execFile(cmd, quoted, { windowsHide: true, shell: windows, timeout: 60_000 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      if (e && (e.code === "ENOENT" || (windows && /not recognized/.test(String(stderr))))) {
        resolve({ code: null, output: "" });
        return;
      }
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, output: `${stdout}${stderr}` });
    });
  });
}

export async function runSetupCli(config: Config, argv: string[]): Promise<number> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const client = flag("--client") ?? "all";
  const clients: Array<"claude" | "codex"> = client === "all" ? ["claude", "codex"] : client === "claude" || client === "codex" ? [client] : [];
  if (!clients.length) {
    console.error('--client must be "claude", "codex" or "all".');
    return 1;
  }
  const scope = (flag("--scope") ?? "user") as SetupOptions["scope"];
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log("TexMex setup\n");
  return runSetup(
    config,
    { clients, scope, packageRoot, nodePath: process.execPath, pathEnv: process.env.PATH ?? "" },
    { promptSecret: promptSecretTTY, log: (l) => console.log(l), run: runCli },
  );
}
