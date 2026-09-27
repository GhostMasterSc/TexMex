#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCheck } from "./check.js";
import { runSetupCli } from "./setup.js";
import { hasCookie, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `TexMex ${VERSION} — Overleaf MCP server for Claude, Codex and other MCP clients

Usage:
  texmex-mcp setup            Log in to Overleaf and connect TexMex to Claude Code / Codex
                             (options: --client claude|codex|all, --scope user|local|project)
  texmex-mcp                 Run the MCP server on stdio (what MCP clients launch)
  texmex-mcp check [project] Check the configuration (and access to a project)
  texmex-mcp --version

Environment:
  OVERLEAF_COOKIE      Your overleaf_session2 browser cookie. Enough on its own (free accounts):
                       sync, edit, push, list projects by name, compile on Overleaf.
  OVERLEAF_COOKIE_FILE File containing the cookie (default ~/.texmex/cookie, written by setup).
  OVERLEAF_GIT_TOKEN   Optional Overleaf Git token (paid plans): sync through the Git bridge instead.
  OVERLEAF_SYNC_MODE   "auto" (default: git if a token is set, else cookie), "git" or "web".
  OVERLEAF_PROJECTS    Optional aliases, e.g. "thesis=<id>,paper=<id>".
  OVERLEAF_URL         Overleaf URL (default https://www.overleaf.com; set for Server Pro).
  OVERLEAF_GIT_URL     Git bridge URL (default https://git.overleaf.com, or <OVERLEAF_URL>/git).
  TEXMEX_WORKDIR       Where working copies live (default ~/.texmex).
  TEXMEX_READ_ONLY     "true" to disable editing and pushing.

Docs: https://github.com/GhostMasterSc/TexMex`;

async function serve(): Promise<void> {
  const config = loadConfig();
  const { server } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the MCP protocol; diagnostics go to stderr.
  console.error(
    `TexMex ${VERSION} running on stdio (working copies in ${config.workdir}${config.readOnly ? ", read-only" : ""}${config.gitToken || hasCookie(config) ? "" : ", WARNING: no Overleaf login; run texmex-mcp setup"})`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "serve":
      await serve();
      return;
    case "setup":
    case "install":
      process.exitCode = await runSetupCli(loadConfig(), rest);
      return;
    case "check":
    case "doctor":
      process.exitCode = await runCheck(loadConfig(), rest[0]);
      return;
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
