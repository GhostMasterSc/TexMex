import { zipSync } from "fflate";
import type { TreeFolder } from "../src/overleafWeb.js";

/**
 * An in-memory imitation of the Overleaf web app endpoints used in free
 * (cookie) mode, following the behaviour of Overleaf's source code:
 * - GET  /Project/:id/download/zip           project as a zip
 * - GET  /project/:id                         editor page with ol-csrfToken / ol-wsUrl
 * - GET  /socket.io/1/?projectId=             socket.io 0.9 handshake (sets a sticky LB cookie)
 * - GET  /socket.io/1/xhr-polling/:sid        emits joinProjectResponse with the file tree
 * - POST /Project/:id/upload?folder_id=       replace-by-name upload; relativePath does mkdirp
 * - DELETE /project/:id/(doc|file|folder)/:id
 */
export class FakeOverleafWeb {
  readonly root: TreeFolder = { _id: "f-root", name: "rootFolder", folders: [], docs: [], fileRefs: [] };
  readonly content = new Map<string, Uint8Array>();
  readonly uploads: string[] = [];
  readonly deletes: string[] = [];
  readonly requests: string[] = [];
  /** Behave like overleaf.com for a session without access: connect, then drop the socket. */
  rejectSocket = false;
  /** Answer the next N zip downloads with HTTP 429, like Overleaf's rate limiter. */
  rateLimitNext = 0;
  handshakes = 0;
  private nextId = 1;
  private sid = 0;
  private polls = new Map<string, number>();

  constructor(
    readonly projectId: string,
    readonly projectName = "Free Paper",
    readonly cookie = "overleaf_session2=good",
  ) {}

  // ---------------------------------------------------------------- tree helpers

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private folderAt(dirPath: string, create: boolean): TreeFolder | undefined {
    let folder = this.root;
    for (const part of dirPath.split("/").filter(Boolean)) {
      let next = folder.folders!.find((f) => f.name === part);
      if (!next) {
        if (!create) return undefined;
        next = { _id: this.id("f"), name: part, folders: [], docs: [], fileRefs: [] };
        folder.folders!.push(next);
      }
      folder = next;
    }
    return folder;
  }

  private findFolderById(id: string, folder = this.root, prefix = ""): { folder: TreeFolder; path: string } | undefined {
    if (folder._id === id) return { folder, path: prefix };
    for (const sub of folder.folders ?? []) {
      const found = this.findFolderById(id, sub, `${prefix}${sub.name}/`);
      if (found) return found;
    }
    return undefined;
  }

  /** Insert or replace an entity by name, like ProjectEntityUpdateHandler.upsertDoc/upsertFile. */
  private upsert(folder: TreeFolder, name: string, data: Uint8Array): { id: string; type: string } {
    const isDoc = !data.includes(0) && /\.(tex|bib|cls|sty|bst|txt|md|bbl|def|cfg)$/i.test(name);
    const existingDoc = folder.docs!.find((d) => d.name === name);
    const existingFile = folder.fileRefs!.find((f) => f.name === name);
    if (isDoc && existingDoc) {
      this.content.set(existingDoc._id, data); // setDocument keeps the doc (and its history)
      return { id: existingDoc._id, type: "doc" };
    }
    folder.docs = folder.docs!.filter((d) => d.name !== name);
    folder.fileRefs = folder.fileRefs!.filter((f) => f.name !== name);
    if (existingDoc) this.content.delete(existingDoc._id);
    if (existingFile) this.content.delete(existingFile._id);
    const id = this.id(isDoc ? "d" : "file");
    (isDoc ? folder.docs! : folder.fileRefs!).push({ _id: id, name });
    this.content.set(id, data);
    return { id, type: isDoc ? "doc" : "file" };
  }

  /** Simulate an edit made in the Overleaf editor (null deletes). */
  set(filePath: string, text: string | null): void {
    const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    const name = filePath.split("/").pop()!;
    const folder = this.folderAt(dir, text !== null);
    if (!folder) return;
    if (text === null) {
      for (const list of [folder.docs!, folder.fileRefs!]) {
        const i = list.findIndex((e) => e.name === name);
        if (i >= 0) {
          this.content.delete(list[i]._id);
          list.splice(i, 1);
        }
      }
      return;
    }
    this.upsert(folder, name, new TextEncoder().encode(text));
  }

  files(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    const walk = (folder: TreeFolder, prefix: string) => {
      for (const e of [...folder.docs!, ...folder.fileRefs!]) out.set(prefix + e.name, this.content.get(e._id)!);
      for (const sub of folder.folders!) walk(sub, `${prefix}${sub.name}/`);
    };
    walk(this.root, "");
    return out;
  }

  read(filePath: string): string | undefined {
    const data = this.files().get(filePath);
    return data ? new TextDecoder().decode(data) : undefined;
  }

  entityId(filePath: string): string | undefined {
    const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    const folder = this.folderAt(dir, false);
    const name = filePath.split("/").pop();
    return [...(folder?.docs ?? []), ...(folder?.fileRefs ?? [])].find((e) => e.name === name)?._id;
  }

  folderExists(dirPath: string): boolean {
    return !!this.folderAt(dirPath, false);
  }

  // ---------------------------------------------------------------- HTTP

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const cookies = headers.get("cookie") ?? "";
    this.requests.push(`${method} ${url.pathname}`);
    if (!cookies.split("; ").includes(this.cookie)) {
      // As observed on overleaf.com with an invalid session:
      if (url.pathname === "/user/projects") return new Response("Unauthorized", { status: 401 });
      if (url.pathname.startsWith("/project/") || url.pathname.startsWith("/Project/")) return new Response("Not found", { status: 404 });
      return new Response(null, { status: 302, headers: { location: "/login" } });
    }
    const csrfOk = headers.get("x-csrf-token") === "csrf-1";
    const pid = this.projectId;
    const p = url.pathname;

    if (p === "/user/projects") return Response.json({ projects: [{ _id: pid, name: this.projectName, accessLevel: "owner" }] });
    if (p === "/project" || p === `/project/${pid}`) {
      return new Response(
        `<html><head><meta name="ol-csrfToken" content="csrf-1"><meta name="ol-wsUrl" content="/socket.io"><meta name="ol-project_id" content="${pid}"></head></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (p === `/Project/${pid}/download/zip` && this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return new Response("Too Many Requests", { status: 429 });
    }
    if (p === `/Project/${pid}/download/zip`) {
      const entries: Record<string, Uint8Array> = {};
      for (const [k, v] of this.files()) entries[k] = v;
      return new Response(zipSync(entries));
    }
    if (p === "/socket.io/1/" && url.searchParams.get("projectId") === pid) {
      this.sid++;
      this.handshakes++;
      return new Response(`sid-${this.sid}:60:60:websocket,xhr-polling`, {
        headers: { "set-cookie": `GCLB=affinity-${this.sid}; Path=/; HttpOnly` },
      });
    }
    const poll = /^\/socket\.io\/1\/xhr-polling\/(sid-\d+)$/.exec(p);
    if (poll) {
      // Without the sticky cookie the load balancer would route to another server.
      if (!cookies.includes(`GCLB=affinity-${poll[1].slice(4)}`)) return new Response("client not handshaken", { status: 400 });
      if (method === "POST") return new Response("1");
      const n = (this.polls.get(poll[1]) ?? 0) + 1;
      this.polls.set(poll[1], n);
      // Observed on overleaf.com: "1::" (connected), then "7:::1+0" (client not handshaken, reconnect).
      if (this.rejectSocket) return new Response(n === 1 ? "1::" : "7:::1+0");
      const event = JSON.stringify({
        name: "joinProjectResponse",
        args: [{ publicId: "P.x", project: { _id: pid, name: this.projectName, rootFolder: [this.root] }, permissionsLevel: "owner", protocolVersion: 2 }],
      });
      const packets = ["1::", `5:::${event}`];
      return new Response(packets.map((pk) => `�${pk.length}�${pk}`).join(""));
    }
    if (p === `/Project/${pid}/upload` && method === "POST") {
      if (!csrfOk) return new Response("Forbidden", { status: 403 });
      const form = init.body as FormData;
      const name = String(form.get("name"));
      const relativePath = form.get("relativePath");
      const file = form.get("qqfile") as Blob;
      const target = this.findFolderById(url.searchParams.get("folder_id") ?? "");
      if (!target) return Response.json({ success: false, error: "folder_not_found" }, { status: 422 });
      let folder = target.folder;
      if (relativePath) {
        const dir = `${target.path}${String(relativePath)}`.split("/").slice(0, -1).join("/");
        folder = this.folderAt(dir, true)!;
      }
      const entity = this.upsert(folder, name, new Uint8Array(await file.arrayBuffer()));
      this.uploads.push(`${relativePath ?? name}`);
      return Response.json({ success: true, entity_id: entity.id, entity_type: entity.type });
    }
    const del = new RegExp(`^/project/${pid}/(doc|file|folder)/([\\w-]+)$`).exec(p);
    if (del && method === "DELETE") {
      if (!csrfOk) return new Response("Forbidden", { status: 403 });
      const [, type, id] = del;
      const removeFrom = (folder: TreeFolder): boolean => {
        const lists = type === "folder" ? [folder.folders!] : [type === "doc" ? folder.docs! : folder.fileRefs!];
        for (const list of lists) {
          const i = list.findIndex((e) => e._id === id);
          if (i >= 0) {
            list.splice(i, 1);
            return true;
          }
        }
        return (folder.folders ?? []).some(removeFrom);
      };
      if (!removeFrom(this.root)) return new Response("Not found", { status: 404 });
      this.content.delete(id);
      this.deletes.push(`${type}:${id}`);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
