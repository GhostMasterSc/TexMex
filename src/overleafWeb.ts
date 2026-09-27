import { UserError } from "./errors.js";

export interface WebProject {
  id: string;
  name: string;
  accessLevel?: string;
  lastUpdated?: string;
}

export interface CompileOutputFile {
  path: string;
  url: string;
  type?: string;
  build?: string;
}

export interface CompileResponse {
  status: string;
  outputFiles?: CompileOutputFile[];
  compileGroup?: string;
  clsiServerId?: string;
  pdfDownloadDomain?: string;
  outputUrlPrefix?: string;
  validationProblems?: unknown;
  error?: unknown;
}

type FetchLike = typeof fetch;

const USER_AGENT = "texmex-mcp (+https://github.com/GhostMasterSc/TexMex)";

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function readMetaTag(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]*\\bname="${escaped}"[^>]*\\bcontent="([^"]*)"`, "i"),
    new RegExp(`<meta[^>]*\\bcontent="([^"]*)"[^>]*\\bname="${escaped}"`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return undefined;
}

/**
 * Minimal client for the parts of the Overleaf web app that the Git bridge
 * does not cover (listing projects, compiling). Authenticates with the
 * browser session cookie. These endpoints are not a public API and may change.
 */
export class OverleafWeb {
  private csrfToken?: string;
  private projectCache?: { at: number; projects: WebProject[] };

  constructor(
    readonly baseUrl: string,
    private readonly cookie: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private isOverleafOrigin(url: string): boolean {
    return new URL(url).origin === new URL(this.baseUrl).origin;
  }

  async request(pathOrUrl: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers);
    // Only ever send the session cookie to the configured Overleaf origin.
    if (this.isOverleafOrigin(url)) headers.set("Cookie", this.cookie);
    headers.set("User-Agent", USER_AGENT);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
    } catch (err) {
      throw new UserError(`Could not reach ${new URL(url).origin}: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (/\/login\b/.test(location)) {
        throw new UserError(
          "The Overleaf session cookie is invalid or has expired. Log in to Overleaf in your browser and copy a fresh `overleaf_session2` cookie into OVERLEAF_COOKIE.",
        );
      }
      if (location && redirects < 5) {
        const next = new URL(location, url).toString();
        const method = res.status === 307 || res.status === 308 ? init.method : "GET";
        const body = method === init.method ? init.body : undefined;
        return this.request(next, { ...init, method, body }, redirects + 1);
      }
    }
    if (res.status === 401) {
      throw new UserError("Overleaf rejected the session cookie (HTTP 401). Refresh OVERLEAF_COOKIE.");
    }
    return res;
  }

  async listProjects(opts: { refresh?: boolean } = {}): Promise<WebProject[]> {
    if (!opts.refresh && this.projectCache && Date.now() - this.projectCache.at < 60_000) {
      return this.projectCache.projects;
    }
    let projects: WebProject[] | undefined;
    const res = await this.request("/user/projects", { headers: { Accept: "application/json" } });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      const body = (await res.json()) as { projects?: Array<Record<string, unknown>> };
      projects = (body.projects ?? []).map((p) => ({
        id: String(p._id ?? p.id),
        name: String(p.name ?? ""),
        accessLevel: p.accessLevel ? String(p.accessLevel) : undefined,
      }));
    } else {
      projects = await this.listProjectsFromDashboard();
    }
    this.projectCache = { at: Date.now(), projects };
    return projects;
  }

  /** Fallback: the project dashboard embeds the project list as JSON in a meta tag. */
  private async listProjectsFromDashboard(): Promise<WebProject[]> {
    const res = await this.request("/project", { headers: { Accept: "text/html" } });
    if (!res.ok) throw new UserError(`Could not load the Overleaf project list (HTTP ${res.status}).`);
    const html = await res.text();
    this.csrfToken = readMetaTag(html, "ol-csrfToken") ?? this.csrfToken;
    const blob = readMetaTag(html, "ol-prefetchedProjectsBlob");
    if (!blob) throw new UserError("Could not find the project list on the Overleaf dashboard page.");
    const data = JSON.parse(blob) as { projects?: Array<Record<string, unknown>> };
    return (data.projects ?? [])
      .filter((p) => !p.archived && !p.trashed)
      .map((p) => ({
        id: String(p.id ?? p._id),
        name: String(p.name ?? ""),
        accessLevel: p.accessLevel ? String(p.accessLevel) : undefined,
        lastUpdated: p.lastUpdated ? String(p.lastUpdated) : undefined,
      }));
  }

  private async getCsrfToken(refresh = false): Promise<string> {
    if (this.csrfToken && !refresh) return this.csrfToken;
    const res = await this.request("/project", { headers: { Accept: "text/html" } });
    if (!res.ok) throw new UserError(`Could not load Overleaf (HTTP ${res.status}) to obtain a CSRF token.`);
    const token = readMetaTag(await res.text(), "ol-csrfToken");
    if (!token) throw new UserError("Could not find Overleaf's CSRF token. Is the session cookie valid?");
    this.csrfToken = token;
    return token;
  }

  async compile(projectId: string, opts: { draft?: boolean; stopOnFirstError?: boolean } = {}): Promise<CompileResponse> {
    const body = JSON.stringify({
      check: "silent",
      draft: !!opts.draft,
      incrementalCompilesEnabled: true,
      stopOnFirstError: !!opts.stopOnFirstError,
    });
    const send = async (token: string) =>
      this.request(`/project/${encodeURIComponent(projectId)}/compile?auto_compile=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Csrf-Token": token },
        body,
      });
    let res = await send(await this.getCsrfToken());
    if (res.status === 403) res = await send(await this.getCsrfToken(true));
    if (res.status === 404) throw new UserError("Overleaf could not find this project, or you do not have access to it.");
    if (res.status === 403) throw new UserError("Overleaf refused the compile request (HTTP 403). Check that the cookie belongs to a collaborator.");
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new UserError(`Overleaf compile request failed (HTTP ${res.status}): ${text}`);
    }
    return (await res.json()) as CompileResponse;
  }

  /** Download one output file of a compile (log, PDF, ...). Returns undefined if unavailable. */
  async downloadOutput(response: CompileResponse, file: CompileOutputFile): Promise<Buffer | undefined> {
    const params = new URLSearchParams();
    if (response.compileGroup) params.set("compileGroup", response.compileGroup);
    if (response.clsiServerId) params.set("clsiserverid", response.clsiServerId);
    const query = params.toString() ? `?${params}` : "";
    const prefix = response.outputUrlPrefix ?? "";
    const candidates = /^https?:\/\//.test(file.url)
      ? [`${file.url}${query}`]
      : [
          `${this.baseUrl}${file.url}${query}`,
          ...(prefix ? [`${this.baseUrl}${prefix}${file.url}${query}`] : []),
          ...(response.pdfDownloadDomain
            ? [`${response.pdfDownloadDomain}${prefix}${file.url}${query}`, `${response.pdfDownloadDomain}${file.url}${query}`]
            : []),
        ];
    for (const url of [...new Set(candidates)]) {
      try {
        const res = await this.request(url);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof UserError && /cookie/.test(err.message)) throw err;
      }
    }
    return undefined;
  }
}
