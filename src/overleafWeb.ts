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

const EXPIRED_COOKIE =
  "The Overleaf session cookie is invalid or has expired. Log in to Overleaf in your browser and copy a fresh `overleaf_session2` cookie value into OVERLEAF_COOKIE.";

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

/** The real-time server dropped our polling session. */
class ConnectionLost extends Error {}

/** One entry of the project file tree sent by Overleaf's real-time service. */
export interface TreeFolder {
  _id: string;
  name: string;
  folders?: TreeFolder[];
  docs?: Array<{ _id: string; name: string }>;
  fileRefs?: Array<{ _id: string; name: string }>;
}

export interface JoinedProject {
  project: { _id?: string; name?: string; rootDoc_id?: string; rootFolder: TreeFolder[] };
  permissionsLevel?: string;
}

export interface SocketPacket {
  type: string;
  data: string;
}

/**
 * Decode a socket.io 0.9 polling payload: either one packet, or several framed
 * as \ufffd<length>\ufffd<packet>. Packets look like `type:id:endpoint:data`.
 */
export function decodeSocketPayload(text: string): SocketPacket[] {
  const frames: string[] = [];
  if (text.startsWith("\ufffd")) {
    let i = 0;
    while (i < text.length && text[i] === "\ufffd") {
      const end = text.indexOf("\ufffd", i + 1);
      if (end < 0) break;
      const length = Number(text.slice(i + 1, end));
      frames.push(text.slice(end + 1, end + 1 + length));
      i = end + 1 + length;
    }
  } else if (text) {
    frames.push(text);
  }
  return frames.map((f) => {
    const m = /^(\d+):([^:]*):([^:]*):?([\s\S]*)$/.exec(f);
    return m ? { type: m[1], data: m[4] ?? "" } : { type: "", data: f };
  });
}

/**
 * Client for the Overleaf web app, authenticated with the browser session
 * cookie. It uses the same endpoints as the Overleaf editor (listing projects,
 * downloading and uploading files, compiling), which work on free accounts but
 * are not a documented API and may change.
 */
export class OverleafWeb {
  private csrfToken?: string;
  private projectCache?: { at: number; projects: WebProject[] };
  /** Cookies set by Overleaf during this session (e.g. load-balancer affinity). */
  private readonly jar = new Map<string, string>();

  constructor(
    readonly baseUrl: string,
    private readonly cookie: string,
    private readonly fetchImpl: FetchLike = fetch,
    /** Waits before retrying a rate-limited download (Overleaf allows 10 per minute and sends no Retry-After). */
    private readonly rateLimitDelaysMs: number[] = [5_000, 10_000, 20_000],
  ) {}

  /**
   * Cookies go only to the configured Overleaf origin and its sibling
   * subdomains (e.g. a separate real-time host), never to other sites.
   */
  private isTrustedOrigin(url: string): boolean {
    const u = new URL(url);
    const base = new URL(this.baseUrl);
    if (u.origin === base.origin) return true;
    if (u.protocol !== base.protocol) return false;
    const parent = base.hostname.split(".").slice(1).join(".");
    return parent.includes(".") && (u.hostname === parent || u.hostname.endsWith(`.${parent}`));
  }

  private cookieHeader(): string {
    const cookies = new Map<string, string>();
    for (const part of this.cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    for (const [k, v] of this.jar) cookies.set(k, v);
    return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private rememberCookies(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    for (const cookie of headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async request(pathOrUrl: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers);
    const trusted = this.isTrustedOrigin(url);
    if (trusted) headers.set("Cookie", this.cookieHeader());
    headers.set("User-Agent", USER_AGENT);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
    } catch (err) {
      throw new UserError(`Could not reach ${new URL(url).origin}: ${(err as Error).message}`);
    }
    if (trusted) this.rememberCookies(res);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (/\/login\b/.test(location)) throw new UserError(EXPIRED_COOKIE);
      if (location && redirects < 5) {
        const next = new URL(location, url).toString();
        const method = res.status === 307 || res.status === 308 ? init.method : "GET";
        const body = method === init.method ? init.body : undefined;
        return this.request(next, { ...init, method, body }, redirects + 1);
      }
    }
    if (res.status === 401) throw new UserError(EXPIRED_COOKIE);
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
    const res = await this.withCsrf(send);
    if (res.status === 404) throw new UserError("Overleaf could not find this project, or you do not have access to it.");
    if (res.status === 403) throw new UserError("Overleaf refused the compile request (HTTP 403). Check that the cookie belongs to a collaborator.");
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new UserError(`Overleaf compile request failed (HTTP ${res.status}): ${text}`);
    }
    return (await res.json()) as CompileResponse;
  }

  private async withCsrf(send: (token: string) => Promise<Response>): Promise<Response> {
    const res = await send(await this.getCsrfToken());
    // A stale token gives 403; fetch a fresh one once.
    return res.status === 403 ? send(await this.getCsrfToken(true)) : res;
  }

  /**
   * Overleaf answers 404 for private projects when the session is not valid, so
   * tell an expired cookie apart from a wrong project ID.
   */
  private async explainNoAccess(): Promise<never> {
    const res = await this.request("/user/projects", { headers: { Accept: "application/json" } });
    await res.body?.cancel();
    throw new UserError("Overleaf could not find this project, or your account does not have access to it. Check the project ID (the part after /project/ in the Overleaf URL).");
  }

  /** Download the whole project as a zip (the editor's "Download → Source"). */
  async downloadZip(projectId: string): Promise<Buffer> {
    const url = `/Project/${encodeURIComponent(projectId)}/download/zip`;
    let res = await this.request(url);
    for (const delay of this.rateLimitDelaysMs) {
      if (res.status !== 429) break;
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
      res = await this.request(url);
    }
    if (res.status === 404 || res.status === 403) await this.explainNoAccess();
    if (res.status === 429) {
      throw new UserError("Overleaf allows 10 project downloads per minute and that limit is reached. Wait a minute and try again.");
    }
    if (!res.ok) throw new UserError(`Downloading the project from Overleaf failed (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Cheap access check: the list of file paths in a project. */
  async projectEntities(projectId: string): Promise<Array<{ path: string; type: string }>> {
    const res = await this.request(`/project/${encodeURIComponent(projectId)}/entities`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new UserError(`Overleaf could not open this project (HTTP ${res.status}).`);
    return ((await res.json()) as { entities?: Array<{ path: string; type: string }> }).entities ?? [];
  }

  /**
   * Fetch the project's file tree with entity IDs. Overleaf only sends it over
   * the editor's real-time connection (socket.io 0.9), which we speak using
   * its plain-HTTP long-polling transport.
   */
  async joinProject(projectId: string): Promise<JoinedProject> {
    const page = await this.request(`/project/${encodeURIComponent(projectId)}`, { headers: { Accept: "text/html" } });
    if (page.status === 404 || page.status === 403) await this.explainNoAccess();
    if (!page.ok) throw new UserError(`Could not open the project in Overleaf (HTTP ${page.status}).`);
    const html = await page.text();
    this.csrfToken = readMetaTag(html, "ol-csrfToken") ?? this.csrfToken;
    const wsUrl = new URL(readMetaTag(html, "ol-wsUrl") || "/socket.io", this.baseUrl);
    const base = `${wsUrl.origin}${wsUrl.pathname.replace(/\/+$/, "")}`;
    const query = `projectId=${encodeURIComponent(projectId)}`;

    // The server advises "reconnect" when a polling session is lost; do that once.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.pollForProject(base, query);
      } catch (err) {
        if (err instanceof ConnectionLost && attempt === 0) continue;
        if (err instanceof ConnectionLost) {
          throw new UserError(
            "Overleaf closed the real-time connection without sending the project. The session cookie may have expired or your account may not have access to this project.",
          );
        }
        throw err;
      }
    }
  }

  private async pollForProject(base: string, query: string): Promise<JoinedProject> {
    const handshake = await this.request(`${base}/1/?${query}&t=${Date.now()}`);
    const hsText = await handshake.text();
    if (!handshake.ok) {
      throw new UserError(`Could not connect to Overleaf's real-time service (HTTP ${handshake.status}): ${hsText.slice(0, 200)}`);
    }
    const [sid, , , transports = ""] = hsText.trim().split(":");
    if (!sid || !transports.split(",").includes("xhr-polling")) {
      throw new UserError(`Unexpected response from Overleaf's real-time service: ${hsText.slice(0, 200)}`);
    }
    const pollUrl = () => `${base}/1/xhr-polling/${sid}?${query}&t=${Date.now()}`;
    const deadline = Date.now() + 45_000;
    try {
      while (Date.now() < deadline) {
        const res = await this.request(pollUrl());
        const body = await res.text();
        if (!res.ok) throw new UserError(`Overleaf's real-time service returned HTTP ${res.status}: ${body.slice(0, 200)}`);
        for (const packet of decodeSocketPayload(body)) {
          if (packet.type === "5") {
            let event: { name?: string; args?: unknown[] };
            try {
              event = JSON.parse(packet.data) as { name?: string; args?: unknown[] };
            } catch {
              continue;
            }
            if (event.name === "joinProjectResponse") {
              const payload = event.args?.[0] as JoinedProject | undefined;
              if (!payload?.project?.rootFolder?.[0]) throw new UserError("Overleaf sent project data without a file tree.");
              return payload;
            }
            if (event.name === "connectionRejected") {
              const reason = (event.args?.[0] as { message?: string } | undefined)?.message ?? "unknown reason";
              throw new UserError(`Overleaf refused to open the project: ${reason}. Is the session cookie valid?`);
            }
          } else if (packet.type === "7") {
            // socket.io 0.9 error: "<reason>+<advice>"; reasons 1 = client not handshaken, 2 = unauthorized.
            const reason = packet.data.split("+")[0];
            if (reason === "1" || reason === "2") throw new ConnectionLost();
            throw new UserError(`Overleaf's real-time service reported an error (${packet.data || "unknown"}).`);
          } else if (packet.type === "0") {
            throw new ConnectionLost();
          }
        }
      }
      throw new UserError("Timed out waiting for Overleaf to send the project's file tree.");
    } finally {
      // Disconnect politely; failures here don't matter.
      this.request(pollUrl(), { method: "POST", body: "0::", headers: { "Content-Type": "text/plain;charset=UTF-8" } })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }
  }

  /**
   * Upload one file, replacing any file with the same name (the editor's
   * "Upload" dialog). Nested paths are created by Overleaf via relativePath.
   */
  async uploadFile(projectId: string, rootFolderId: string, relPath: string, content: Buffer): Promise<void> {
    const name = relPath.split("/").pop() ?? relPath;
    const form = new FormData();
    form.append("name", name);
    if (relPath.includes("/")) form.append("relativePath", relPath);
    form.append("qqfile", new Blob([new Uint8Array(content)]), name);
    const url = `/Project/${encodeURIComponent(projectId)}/upload?folder_id=${encodeURIComponent(rootFolderId)}`;
    const res = await this.withCsrf((token) =>
      this.request(url, { method: "POST", headers: { Accept: "application/json", "X-Csrf-Token": token }, body: form }),
    );
    let body: { success?: boolean; error?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON error page
    }
    if (!res.ok || body.success === false) {
      const reason =
        body.error === "project_has_too_many_files"
          ? "the project has too many files"
          : body.error === "invalid_filename"
            ? "invalid file name"
            : body.error ?? `HTTP ${res.status}`;
      throw new UserError(`Overleaf rejected the upload of ${relPath}: ${reason}.`);
    }
  }

  async deleteEntity(projectId: string, type: "doc" | "file" | "folder", entityId: string): Promise<void> {
    const url = `/project/${encodeURIComponent(projectId)}/${type}/${encodeURIComponent(entityId)}`;
    const res = await this.withCsrf((token) => this.request(url, { method: "DELETE", headers: { "X-Csrf-Token": token } }));
    if (res.status === 404) return; // already gone
    if (!res.ok) throw new UserError(`Overleaf refused to delete a ${type} (HTTP ${res.status}).`);
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
          // Overleaf already appends outputUrlPrefix to pdfDownloadDomain.
          ...(response.pdfDownloadDomain ? [`${response.pdfDownloadDomain}${file.url}${query}`] : []),
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
