import os from "node:os";
import path from "node:path";

export interface Config {
  /** Overleaf Git authentication token (Account settings → Git integration). */
  gitToken?: string;
  /** Username sent with the token. Overleaf always uses "git". */
  gitUsername: string;
  /** Base URL of the Git bridge; the clone URL is `${gitBaseUrl}/${projectId}`. */
  gitBaseUrl: string;
  /** Base URL of the Overleaf web app (used with the session cookie). */
  webBaseUrl: string;
  /** Full `Cookie` header value for the Overleaf web app, if configured. */
  cookie?: string;
  /** Where local working copies and build outputs live. */
  workdir: string;
  /** Friendly name → project id. */
  projectAliases: Record<string, string>;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  /** Disable every tool that modifies files or pushes to Overleaf. */
  readOnly: boolean;
  /** Re-fetch from Overleaf when a project was last fetched longer ago than this. 0 disables auto-sync. */
  autoSyncSeconds: number;
  latexmkPath: string;
  compileTimeoutMs: number;
  gitTimeoutMs: number;
  /** Allow latexmk to read latexmkrc files (they are Perl code and can run arbitrary commands). */
  allowLatexmkrc: boolean;
}

export const DEFAULT_WEB_URL = "https://www.overleaf.com";
export const DEFAULT_GIT_URL = "https://git.overleaf.com";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Accepts either `name=id,name2=id2` or a JSON object `{"name": "id"}`.
 * Values may also be full Overleaf project URLs.
 */
export function parseProjectAliases(raw: string | undefined): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!raw || !raw.trim()) return aliases;
  const text = raw.trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) aliases[name.trim()] = value.trim();
    }
    return aliases;
  }
  for (const entry of text.split(/[,;\n]/)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (name && value) aliases[name] = value;
  }
  return aliases;
}

/**
 * Users paste either the bare `overleaf_session2` value or a full cookie header.
 */
export function normalizeCookie(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  if (!value) return undefined;
  if (/^cookie:/i.test(value)) value = value.slice("cookie:".length).trim();
  if (!value.includes("=")) value = `overleaf_session2=${value}`;
  return value;
}

function defaultGitUrl(webBaseUrl: string): string {
  try {
    const host = new URL(webBaseUrl).hostname;
    if (host === "overleaf.com" || host.endsWith(".overleaf.com")) return DEFAULT_GIT_URL;
  } catch {
    // fall through to the Server Pro convention
  }
  // Overleaf Server Pro serves the Git bridge under /git on the same host.
  return `${webBaseUrl}/git`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const webBaseUrl = trimSlash(env.OVERLEAF_URL?.trim() || DEFAULT_WEB_URL);
  const gitBaseUrl = trimSlash(env.OVERLEAF_GIT_URL?.trim() || defaultGitUrl(webBaseUrl));
  const workdir = path.resolve(
    expandHome(env.TEXMEX_WORKDIR?.trim() || path.join(os.homedir(), ".texmex")),
  );
  return {
    gitToken: env.OVERLEAF_GIT_TOKEN?.trim() || undefined,
    gitUsername: env.OVERLEAF_GIT_USERNAME?.trim() || "git",
    gitBaseUrl,
    webBaseUrl,
    cookie: normalizeCookie(env.OVERLEAF_COOKIE),
    workdir,
    projectAliases: parseProjectAliases(env.OVERLEAF_PROJECTS),
    gitAuthorName: env.TEXMEX_GIT_AUTHOR_NAME?.trim() || undefined,
    gitAuthorEmail: env.TEXMEX_GIT_AUTHOR_EMAIL?.trim() || undefined,
    readOnly: parseBool(env.TEXMEX_READ_ONLY, false),
    autoSyncSeconds: parseNumber(env.TEXMEX_AUTO_SYNC_SECONDS, 300),
    latexmkPath: env.TEXMEX_LATEXMK?.trim() || "latexmk",
    compileTimeoutMs: parseNumber(env.TEXMEX_COMPILE_TIMEOUT_SECONDS, 180) * 1000,
    gitTimeoutMs: parseNumber(env.TEXMEX_GIT_TIMEOUT_SECONDS, 300) * 1000,
    allowLatexmkrc: parseBool(env.TEXMEX_ALLOW_LATEXMKRC, false),
  };
}
