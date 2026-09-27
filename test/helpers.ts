import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { TexMex } from "../src/context.js";

export const PROJECT_ID = "64a1b2c3d4e5f60718293a4b";

export const SEED_FILES: Record<string, string> = {
  "main.tex": [
    "\\documentclass{article}",
    "\\title{A Test Paper}\\author{A. Author}",
    "\\begin{document}",
    "\\maketitle",
    "\\input{sections/intro}",
    "\\section{Method}\\label{sec:method}",
    "We use the method of \\cite{knuth84}.",
    "See Section~\\ref{sec:intro}.",
    "\\bibliographystyle{plain}",
    "\\bibliography{refs}",
    "\\end{document}",
    "",
  ].join("\n"),
  "sections/intro.tex": [
    "\\section{Introduction}\\label{sec:intro}",
    "This is the introduction.",
    "It has a second line.",
    "",
  ].join("\n"),
  "refs.bib": [
    "@book{knuth84,",
    "  author = {Donald E. Knuth},",
    "  title = {The {\\TeX}book},",
    "  publisher = {Addison-Wesley},",
    "  year = {1984}",
    "}",
    "",
  ].join("\n"),
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Overleaf",
      GIT_AUTHOR_EMAIL: "overleaf@example.com",
      GIT_COMMITTER_NAME: "Overleaf",
      GIT_COMMITTER_EMAIL: "overleaf@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

/** A stand-in for Overleaf's Git bridge: one bare repository per project id. */
export class FakeOverleaf {
  readonly root: string;
  readonly remotes: string;
  readonly workdir: string;

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "texmex-test-"));
    this.remotes = path.join(this.root, "remotes");
    this.workdir = path.join(this.root, "work");
    fs.mkdirSync(this.remotes, { recursive: true });
  }

  createProject(id = PROJECT_ID, files: Record<string, string> = SEED_FILES): void {
    const bare = path.join(this.remotes, id);
    git(this.remotes, "init", "--quiet", "--bare", "-b", "master", bare);
    this.commit(id, files, "Initial version", true);
  }

  /** Simulate a collaborator editing on Overleaf (null deletes a file). */
  commit(id: string, files: Record<string, string | null>, message = "Update on Overleaf.", initial = false): string {
    const tmp = fs.mkdtempSync(path.join(this.root, "collab-"));
    if (initial) {
      git(tmp, "init", "--quiet", "-b", "master");
      git(tmp, "remote", "add", "origin", path.join(this.remotes, id));
    } else {
      git(this.root, "clone", "--quiet", path.join(this.remotes, id), tmp);
    }
    for (const [file, content] of Object.entries(files)) {
      const abs = path.join(tmp, file);
      if (content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    }
    git(tmp, "add", "-A");
    git(tmp, "commit", "--quiet", "-m", message);
    git(tmp, "push", "--quiet", "origin", "HEAD:master");
    const hash = git(tmp, "rev-parse", "HEAD").trim();
    fs.rmSync(tmp, { recursive: true, force: true });
    return hash;
  }

  /** Read a file as it currently is "on Overleaf". */
  read(id: string, file: string): string {
    return git(path.join(this.remotes, id), "show", `master:${file}`);
  }

  commitCount(id: string): number {
    return Number(git(path.join(this.remotes, id), "rev-list", "--count", "master").trim());
  }

  config(env: Record<string, string> = {}): Config {
    return loadConfig({
      OVERLEAF_GIT_URL: `file://${this.remotes}`,
      TEXMEX_WORKDIR: this.workdir,
      TEXMEX_GIT_AUTHOR_NAME: "Agent",
      TEXMEX_GIT_AUTHOR_EMAIL: "agent@example.com",
      ...env,
    });
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

export interface Harness {
  client: Client;
  texmex: TexMex;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; raw: unknown }>;
  close(): Promise<void>;
}

export async function connect(config: Config, opts: { fetch?: typeof fetch } = {}): Promise<Harness> {
  const { server, texmex } = createServer(config, opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "texmex-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    texmex,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { text, isError: !!result.isError, raw: result };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
