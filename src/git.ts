import { execFile } from "node:child_process";
import type { Config } from "./config.js";
import { UserError } from "./errors.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitRunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Return non-zero exits instead of throwing. */
  allowFail?: boolean;
  /** Set author/committer identity (needed for commits and merges). */
  identity?: boolean;
  /** Extra environment variables (applied last). */
  env?: Record<string, string>;
}

export class GitError extends UserError {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitRunner {
  private identityEnv?: Promise<Record<string, string>>;

  constructor(private readonly config: Config) {}

  private get authHeader(): string | undefined {
    if (!this.config.gitToken) return undefined;
    const basic = Buffer.from(`${this.config.gitUsername}:${this.config.gitToken}`).toString("base64");
    return `Authorization: Basic ${basic}`;
  }

  /**
   * Build the environment for a git invocation. Configuration is injected via
   * GIT_CONFIG_* variables so the token is never written to .git/config or
   * exposed on the command line, and is only sent to the Overleaf git host.
   */
  private baseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANGUAGE: "C",
    };
    const settings: Array<[string, string]> = [
      ["core.quotepath", "false"],
      ["core.autocrlf", "false"],
      ["commit.gpgsign", "false"],
      ["advice.detachedHead", "false"],
      ["init.defaultBranch", "master"],
      // Only ever authenticate with the configured token; never pop up
      // keychain dialogs or reuse unrelated stored credentials.
      ["credential.helper", ""],
    ];
    const header = this.authHeader;
    if (header) settings.push([`http.${this.config.gitBaseUrl}/.extraHeader`, header]);

    const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    settings.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${start + i}`] = key;
      env[`GIT_CONFIG_VALUE_${start + i}`] = value;
    });
    env.GIT_CONFIG_COUNT = String(start + settings.length);
    return env;
  }

  private async identity(): Promise<Record<string, string>> {
    this.identityEnv ??= (async () => {
      let name = this.config.gitAuthorName;
      let email = this.config.gitAuthorEmail;
      if (!name) name = (await this.run(["config", "--get", "user.name"], { allowFail: true })).stdout.trim();
      if (!email) email = (await this.run(["config", "--get", "user.email"], { allowFail: true })).stdout.trim();
      name ||= "TexMex";
      email ||= "texmex@localhost";
      return {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      };
    })();
    return this.identityEnv;
  }

  /** Remove anything credential-like from text that may be shown to the agent. */
  scrub(text: string): string {
    let out = text;
    const token = this.config.gitToken;
    if (token) out = out.split(token).join("***");
    const header = this.authHeader;
    if (header) out = out.split(header.slice("Authorization: Basic ".length)).join("***");
    return out;
  }

  async run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const env = this.baseEnv();
    if (opts.identity) Object.assign(env, await this.identity());
    if (opts.env) Object.assign(env, opts.env);
    const timeout = opts.timeoutMs ?? this.config.gitTimeoutMs;

    const result = await new Promise<GitResult & { error?: NodeJS.ErrnoException & { killed?: boolean } }>(
      (resolve) => {
        execFile(
          "git",
          args,
          { cwd: opts.cwd, env, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
          (error, stdout, stderr) => {
            const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
            const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code, error: err ?? undefined });
          },
        );
      },
    );

    if (result.error && result.error.code === "ENOENT" && result.code === -1) {
      throw new UserError("git is not installed or not on PATH. Install git to use TexMex.");
    }
    if (result.error?.killed) {
      throw new GitError(
        `git ${args[0]} timed out after ${Math.round(timeout / 1000)}s`,
        args,
        null,
        this.scrub(result.stdout),
        this.scrub(result.stderr),
      );
    }

    const stdout = this.scrub(result.stdout);
    const stderr = this.scrub(result.stderr);
    if (result.code !== 0 && !opts.allowFail) {
      throw new GitError(describeGitFailure(args, stderr || stdout, !!this.config.gitToken), args, result.code, stdout, stderr);
    }
    return { stdout, stderr, code: result.code };
  }
}

export function describeGitFailure(args: string[], output: string, hasToken: boolean): string {
  const detail = output.trim().split("\n").slice(-12).join("\n");
  const base = `git ${args[0]} failed${detail ? `:\n${detail}` : ""}`;
  if (/could not read Username|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied|\b401\b/i.test(output)) {
    return hasToken
      ? `${base}\n\nOverleaf rejected the Git token. Create a new one under Overleaf → Account Settings → Git Integration and update OVERLEAF_GIT_TOKEN.`
      : `${base}\n\nNo Overleaf credentials are configured. Set OVERLEAF_COOKIE (your overleaf_session2 browser cookie; works with free accounts) or OVERLEAF_GIT_TOKEN (Overleaf → Account Settings → Git Integration; paid plans).`;
  }
  if (/\b403\b|forbidden/i.test(output)) {
    return `${base}\n\nAccess denied. Git integration requires an Overleaf plan that includes it, and you must be a collaborator on the project.`;
  }
  if (/repository .* not found|\b404\b|does not appear to be a git repository|not found/i.test(output)) {
    return `${base}\n\nOverleaf could not find this project. Check the project ID (the part after /project/ in the Overleaf URL).`;
  }
  return base;
}
