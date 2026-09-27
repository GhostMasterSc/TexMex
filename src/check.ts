import fs from "node:fs/promises";
import path from "node:path";
import { commandExists } from "./compile.js";
import { chooseSyncMode, hasCookie, type Config } from "./config.js";
import { TexMex } from "./context.js";
import { errorMessage } from "./errors.js";

/** `texmex-mcp check [project]`: verify the configuration from a terminal. */
export async function runCheck(config: Config, projectRef?: string): Promise<number> {
  const texmex = new TexMex(config);
  let failures = 0;
  const ok = (m: string) => console.log(`  ✓ ${m}`);
  const bad = (m: string) => {
    failures++;
    console.log(`  ✗ ${m}`);
  };
  const info = (m: string) => console.log(`  • ${m}`);

  console.log("TexMex configuration check\n");
  info(`Overleaf: ${config.webBaseUrl}  (Git bridge: ${config.gitBaseUrl})`);
  info(`Working copies: ${config.workdir}${config.readOnly ? "  [read-only mode]" : ""}`);

  try {
    const v = await texmex.git.run(["--version"]);
    ok(v.stdout.trim());
  } catch (err) {
    bad(errorMessage(err));
  }

  try {
    await fs.mkdir(config.workdir, { recursive: true });
    const probe = path.join(config.workdir, `.write-test-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.rm(probe);
    ok("Working directory is writable");
  } catch (err) {
    bad(`Cannot write to ${config.workdir}: ${errorMessage(err)}`);
  }

  const mode = chooseSyncMode(config);
  if (config.gitToken) ok("OVERLEAF_GIT_TOKEN is set");
  else if (hasCookie(config)) info("OVERLEAF_GIT_TOKEN not set — using the free, cookie-based sync");
  else bad("No Overleaf login: run `texmex-mcp setup`, or set OVERLEAF_COOKIE (free accounts) or OVERLEAF_GIT_TOKEN (paid plans)");
  if (config.cookieFile) info(`Cookie is read from ${config.cookieFile}`);
  for (const warning of config.credentialWarnings) bad(warning);
  info(`New projects sync via ${mode === "git" ? "the Git bridge" : "the Overleaf website (session cookie)"}`);

  if (texmex.web) {
    try {
      const projects = await texmex.webProjects(true);
      ok(`OVERLEAF_COOKIE works: ${projects.length} project(s) in your account`);
    } catch (err) {
      bad(`OVERLEAF_COOKIE: ${errorMessage(err)}`);
    }
  } else {
    info("OVERLEAF_COOKIE not set (optional: enables listing projects by name and compiling on Overleaf)");
  }

  if (await commandExists(config.latexmkPath)) ok(`latexmk found (${config.latexmkPath}) — local compiles available`);
  else info("latexmk not found (optional: needed for local compiles)");

  const aliases = texmex.aliasEntries();
  if (aliases.length) info(`Aliases: ${aliases.map((a) => `${a.name}=${a.id}`).join(", ")}`);

  if (projectRef) {
    try {
      const project = await texmex.resolve(projectRef);
      const label = `${project.name ? `"${project.name}" ` : ""}(${project.id})`;
      if (mode === "git") {
        await texmex.git.run(["ls-remote", "--heads", "--", texmex.workspace(project.id).remoteUrl]);
        ok(`Git access to project ${label} works`);
      } else if (texmex.web) {
        const files = await texmex.web.projectEntities(project.id);
        ok(`Access to project ${label} works (${files.length} files)`);
      }
    } catch (err) {
      bad(`Project ${projectRef}: ${errorMessage(err)}`);
    }
  } else {
    info("Pass a project ID or URL (texmex-mcp check <project>) to test access to it.");
  }

  console.log(failures ? `\n${failures} problem(s) found.` : "\nAll good.");
  return failures ? 1 : 0;
}
