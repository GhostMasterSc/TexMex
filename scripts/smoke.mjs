// Launch the built server over stdio exactly like an MCP client would and list its tools.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "texmex-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, TEXMEX_WORKDIR: workdir },
  stderr: "ignore",
});
const client = new Client({ name: "texmex-smoke", version: "0.0.0" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();
  const result = await client.callTool({ name: "list_projects", arguments: {} });
  if (tools.length < 15 || prompts.length < 1 || result.isError) {
    throw new Error(`unexpected server response: ${tools.length} tools, ${prompts.length} prompts`);
  }
  console.log(`OK: TexMex ${client.getServerVersion()?.version} on Node ${process.version} — ${tools.length} tools, ${prompts.length} prompts`);
} finally {
  await client.close();
  fs.rmSync(workdir, { recursive: true, force: true });
}
