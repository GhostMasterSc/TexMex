import fs from "node:fs/promises";
import path from "node:path";
import { cookieSource, type Config } from "./config.js";
import { UserError } from "./errors.js";
import { GitRunner } from "./git.js";
import { OverleafWeb, type WebProject } from "./overleafWeb.js";
import { Workspace } from "./workspace.js";

export interface ProjectRef {
  id: string;
  name?: string;
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Extract a project id from an id, an Overleaf project URL or a git clone URL. */
export function extractProjectId(ref: string): string | undefined {
  const t = ref.trim();
  if (OBJECT_ID.test(t)) return t.toLowerCase();
  const m =
    /\/project\/([0-9a-f]{24})(?![0-9a-f])/i.exec(t) ??
    /\/\/git\.[^/]+\/([0-9a-f]{24})(?![0-9a-f])/i.exec(t) ??
    /\/git\/([0-9a-f]{24})(?![0-9a-f])/i.exec(t);
  return m?.[1].toLowerCase();
}

interface RegistryData {
  projects: Record<string, { name?: string }>;
}

/** Remembers project names so they can be resolved without the web session. */
export class Registry {
  private data?: RegistryData;
  constructor(private readonly file: string) {}

  private async load(): Promise<RegistryData> {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8")) as RegistryData;
      this.data.projects ??= {};
    } catch {
      this.data = { projects: {} };
    }
    return this.data;
  }

  async entries(): Promise<Array<[string, { name?: string }]>> {
    return Object.entries((await this.load()).projects);
  }

  async name(id: string): Promise<string | undefined> {
    return (await this.load()).projects[id]?.name;
  }

  async setNames(projects: Array<{ id: string; name?: string }>): Promise<void> {
    const data = await this.load();
    let changed = false;
    for (const p of projects) {
      if (!p.name) continue;
      if (data.projects[p.id]?.name !== p.name) {
        data.projects[p.id] = { ...data.projects[p.id], name: p.name };
        changed = true;
      }
    }
    if (!changed) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2));
  }
}

export class TexMex {
  readonly git: GitRunner;
  readonly web?: OverleafWeb;
  readonly registry: Registry;
  private readonly workspaces = new Map<string, Workspace>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    readonly config: Config,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.git = new GitRunner(config);
    const cookie = cookieSource(config);
    if (cookie) this.web = new OverleafWeb(config.webBaseUrl, cookie, opts.fetch);
    this.registry = new Registry(path.join(config.workdir, "registry.json"));
  }

  workspace(id: string): Workspace {
    let ws = this.workspaces.get(id);
    if (!ws) {
      ws = new Workspace(this.config, this.git, id, this.web);
      this.workspaces.set(id, ws);
    }
    return ws;
  }

  buildDir(id: string): string {
    return path.join(this.config.workdir, "builds", id);
  }

  async localProjectIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.config.workdir, "projects"), { withFileTypes: true });
      const ids: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory() || !OBJECT_ID.test(e.name)) continue;
        if (await this.workspace(e.name).isCloned()) ids.push(e.name);
      }
      return ids.sort();
    } catch {
      return [];
    }
  }

  aliasEntries(): ProjectRef[] {
    const out: ProjectRef[] = [];
    for (const [name, value] of Object.entries(this.config.projectAliases)) {
      const id = extractProjectId(value);
      if (id) out.push({ id, name });
    }
    return out;
  }

  async webProjects(refresh = false): Promise<WebProject[]> {
    if (!this.web) return [];
    const projects = await this.web.listProjects({ refresh });
    await this.registry.setNames(projects);
    return projects;
  }

  async resolve(ref: string): Promise<ProjectRef> {
    const input = ref.trim();
    if (!input) throw new UserError("A project is required (ID, URL or name).");
    const direct = extractProjectId(input);
    if (direct) return { id: direct, name: await this.registry.name(direct) };

    const lower = input.toLowerCase();
    const alias = Object.entries(this.config.projectAliases).find(([name]) => name.toLowerCase() === lower);
    if (alias) {
      const id = extractProjectId(alias[1]);
      if (!id) throw new UserError(`OVERLEAF_PROJECTS maps "${alias[0]}" to "${alias[1]}", which is not a project ID or URL.`);
      return { id, name: alias[0] };
    }

    const known: ProjectRef[] = (await this.registry.entries()).map(([id, v]) => ({ id, name: v.name }));
    const exactKnown = known.filter((p) => p.name?.toLowerCase() === lower);
    if (exactKnown.length === 1) return exactKnown[0];

    let webError: string | undefined;
    let candidates: ProjectRef[] = known;
    if (this.web) {
      try {
        const projects = await this.webProjects();
        const exact = projects.filter((p) => p.name.toLowerCase() === lower);
        if (exact.length === 1) return { id: exact[0].id, name: exact[0].name };
        if (exact.length > 1) {
          throw new UserError(
            `Several projects are named "${input}": ${exact.map((p) => p.id).join(", ")}. Pass the project ID instead.`,
          );
        }
        candidates = projects.map((p) => ({ id: p.id, name: p.name }));
      } catch (err) {
        if (err instanceof UserError && /Several projects/.test(err.message)) throw err;
        webError = (err as Error).message;
      }
    }

    const partial = candidates.filter((p) => p.name?.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new UserError(
        `"${input}" matches several projects: ${partial
          .slice(0, 10)
          .map((p) => `"${p.name}" (${p.id})`)
          .join(", ")}. Use the exact name or the project ID.`,
      );
    }
    const hint = this.web
      ? webError
        ? `Could not load your Overleaf project list: ${webError}`
        : "No project in your Overleaf account has that name."
      : "Set OVERLEAF_COOKIE to look projects up by name, or define aliases with OVERLEAF_PROJECTS.";
    throw new UserError(
      `Unknown project "${input}". Pass the project ID or URL (overleaf.com/project/<id>). ${hint}`,
    );
  }

  /** Run `fn` with exclusive access to a project's working copy. */
  async withProject<T>(
    ref: string,
    fn: (ctx: { ws: Workspace; project: ProjectRef; notes: string[] }) => Promise<T>,
    opts: { autoSync?: boolean } = {},
  ): Promise<T> {
    const project = await this.resolve(ref);
    return this.exclusive(project.id, async () => {
      const ws = this.workspace(project.id);
      const notes = opts.autoSync === false ? [] : await ws.autoSync();
      return fn({ ws, project, notes });
    });
  }

  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const settled = run.catch(() => undefined);
    this.queues.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    }
  }
}
