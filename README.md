# TexMex — an Overleaf MCP server

TexMex lets AI agents such as **Claude Code**, **Claude Desktop** and **OpenAI Codex** work on your
[Overleaf](https://www.overleaf.com) LaTeX projects: read and search the source, edit files, check the
document for broken references, compile it and fix errors, and push the result back to Overleaf so your
co-authors see it. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio, so
it works with any MCP client.

```text
You: "Fix the compile errors in my thesis and tighten the abstract."
Agent: sync_project → compile → read_file/edit_file → compile → get_diff → (asks you) → push_changes
```

## Features

- **Read**: list projects, files and history; read files (images are shown as images); search with
  regex/globs; `get_outline` shows the section tree with `file:line` locations.
- **Static checks without compiling**: missing `\input` files and images, undefined `\ref` labels,
  citation keys missing from your `.bib`, duplicate labels.
- **Edit**: exact find-and-replace edits, whole-file writes, move/delete files, copy local files (e.g. a
  plot you just generated) into the project.
- **Compile** locally with `latexmk` or **on Overleaf's servers**, with errors and warnings parsed into
  `file:line — message` form, plus the raw log on demand.
- **Collaborate safely**: edits stay local until you push; Overleaf changes by co-authors are merged
  automatically, and real conflicts are surfaced as standard conflict markers for the agent to resolve.

## Do I need to host a server?

No. TexMex runs **on your own computer**: Claude Code, Codex or Claude Desktop start it automatically
as a small background process when they launch and talk to it over stdin/stdout. There is nothing to
deploy and nothing to pay for — you only need Node.js installed. (The MCP server is not reachable from
the internet; the claude.ai website and phone apps cannot use it.)

## How it works

TexMex keeps a local working copy of each project (in `~/.texmex/projects/<id>`); the agent's tools
operate on that copy, and nothing reaches Overleaf until `push_changes`. Before pushing, TexMex fetches
Overleaf's latest version and merges your co-authors' edits, so it never overwrites work done on
Overleaf. There are two ways to talk to Overleaf:

| | **Free** (session cookie) | **Git bridge** (Git token) |
| --- | --- | --- |
| Overleaf plan | any, including **free** | paid plans / institutional licenses / Server Pro |
| Credential | `OVERLEAF_COOKIE` (your browser session) | `OVERLEAF_GIT_TOKEN` (+ optional cookie) |
| Download | the editor's *Download → Source* zip | `git fetch` |
| Upload | the editor's *Upload* feature, one changed file at a time; deletions via the file tree | `git push` (one commit) |
| History (`get_history`) | versions TexMex downloaded or pushed | Overleaf's full Git history |
| Stability | uses the Overleaf editor's own, undocumented endpoints; may break if Overleaf changes them | official, documented feature |

TexMex picks the Git bridge when a token is set and the free route otherwise (override with
`OVERLEAF_SYNC_MODE`). Both give the agent the same tools. Listing projects by name and compiling on
Overleaf always use the cookie.

## Requirements

- **Node.js 20+** and **git** (git is used for the local working copies in both modes).
- An Overleaf account — the free plan works.
- Optional: a TeX distribution with `latexmk` (TeX Live, MacTeX or MiKTeX) for local compiles.

## Installation

```bash
git clone https://github.com/GhostMasterSc/TexMex.git
cd TexMex
npm install          # installs dependencies and builds dist/
```

The server entry point is `dist/index.js`. Use its **absolute path** in the client configuration below
(`pwd` prints it).

## Credentials

### Session cookie (free — all you need)

Log in to [overleaf.com](https://www.overleaf.com) in your browser, open the developer tools (F12) →
*Application* (Chrome/Edge) or *Storage* (Firefox) → *Cookies* → `https://www.overleaf.com`, and copy
the **value** of `overleaf_session2`. Provide it to TexMex as `OVERLEAF_COOKIE`.

> The cookie works like your password while that browser session lasts. Keep it out of files you
> commit, never share it, and log out of that browser session to revoke it. Sessions last a few days;
> when yours expires (or you log out), TexMex tells you and you copy a fresh value.

Self-hosted Overleaf (Community Edition / Server Pro) names the cookie `overleaf.sid` by default; pass
it as `OVERLEAF_COOKIE="overleaf.sid=<value>"` and set `OVERLEAF_URL`.

### Git token (optional, paid plans)

If your plan includes Git integration you can use it instead: **Account Settings → Git Integration →
Generate token** (starts with `olp_`), provided as `OVERLEAF_GIT_TOKEN`. The token is sent only to the
Overleaf Git host and is never written into the working copies' `.git/config`. Add the cookie as well
if you want to list projects by name and compile on Overleaf.

## Connect it to your agent

In the examples, replace `/path/to/TexMex` with the absolute path of your clone and
`your_cookie_value` with the `overleaf_session2` value. (Git-token users: use
`OVERLEAF_GIT_TOKEN=olp_…` in addition or instead.)

### Claude Code

```bash
claude mcp add overleaf --scope user \
  --env OVERLEAF_COOKIE=your_cookie_value \
  -- node /path/to/TexMex/dist/index.js
```

Or share it with a team in a project's `.mcp.json` (Claude Code expands `${VAR}` from each user's
environment, so no secrets are committed):

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/path/to/TexMex/dist/index.js"],
      "env": { "OVERLEAF_COOKIE": "${OVERLEAF_COOKIE}" }
    }
  }
}
```

Run `/mcp` inside Claude Code to check that the `overleaf` server is connected. The two bundled prompts
are available as `/mcp__overleaf__fix_compile_errors` and `/mcp__overleaf__review_recent_changes`.

### OpenAI Codex

```bash
codex mcp add overleaf \
  --env OVERLEAF_COOKIE=your_cookie_value \
  -- node /path/to/TexMex/dist/index.js
```

or add it to `~/.codex/config.toml` directly:

```toml
[mcp_servers.overleaf]
command = "node"
args = ["/path/to/TexMex/dist/index.js"]
env = { OVERLEAF_COOKIE = "your_cookie_value" }
# Downloading a large project or compiling can take longer than Codex's 60 s default.
tool_timeout_sec = 300
```

### Claude Desktop and other MCP clients

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config), or the equivalent
file of your client:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/path/to/TexMex/dist/index.js"],
      "env": { "OVERLEAF_COOKIE": "your_cookie_value" }
    }
  }
}
```

### Check the setup

```bash
OVERLEAF_COOKIE=your_cookie_value node /path/to/TexMex/dist/index.js check https://www.overleaf.com/project/<id>
```

`check` verifies git, the working directory, your credentials, access to that project and `latexmk`,
and explains what to fix.

## Using it

Tell the agent which project to use. Anything that identifies it works: the URL from your browser
(`https://www.overleaf.com/project/64a1…`), the bare ID, the project's name (with `OVERLEAF_COOKIE`),
or an alias you defined in `OVERLEAF_PROJECTS`.

- *"Open my Overleaf project https://www.overleaf.com/project/64a1… and give me an outline."*
- *"Compile the thesis and fix every error. Show me the diff before pushing."*
- *"Find all `\cite` keys that aren't in references.bib."*
- *"Add the figure at ~/plots/loss.pdf to the results section with a caption, then push."*
- *"What did my co-authors change since last week?"*

Edits are **not visible on Overleaf until `push_changes`**. TexMex instructs agents to show you the diff
and ask before pushing unless you already told them to push.

### Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects from your account (cookie), aliases and local copies, with pending-change counts |
| `sync_project` | Fetch the latest version from Overleaf and merge it with local edits (clones on first use) |
| `list_files` | Files with sizes; marks the main document and files with unpushed changes |
| `read_file` | Read a file with line numbers (paged with `offset`/`limit`); images are returned as images |
| `search_project` | Text/regex search with glob filter and context lines |
| `get_outline` | Main file, included files, section tree with labels and `file:line`, static reference/citation/file checks |
| `get_status` | Pending local changes, conflicts, how current the copy is, where it lives on disk |
| `get_diff` | Unified diff of pending changes, or of everything since a given commit |
| `get_history` | Recent versions with changed files (full Overleaf history with a Git token; versions TexMex saw in free mode) |
| `compile` | Compile locally (`latexmk`) or on Overleaf; parsed errors/warnings with locations |
| `get_compile_log` | Tail of the raw log of the last compile, or lines matching a pattern |
| `write_file` | Create or overwrite a text file |
| `edit_file` | Replace an exact, unique piece of text (or all occurrences) |
| `delete_file` / `move_file` | Delete or move/rename files and folders |
| `import_file` | Copy a file from your computer (e.g. a generated figure) into the project |
| `push_changes` | Publish all pending changes to Overleaf, merging co-authors' edits first |
| `discard_changes` | Throw away pending changes to some paths, or all of them (also aborts a conflicted merge) |

### Compiling

`compile` has three modes:

- `where: "local"` runs `latexmk` on this machine against your local copy, **including unpushed
  edits** — the fastest loop for fixing errors. The engine is picked automatically (XeLaTeX for
  `fontspec`/`polyglossia`/`unicode-math`, LuaLaTeX for `\directlua`, otherwise pdfLaTeX) or can be set.
- `where: "overleaf"` compiles on Overleaf's servers with the project's own settings (compiler, TeX Live
  version, main document), exactly as collaborators see it. It compiles the **last pushed** version and
  needs `OVERLEAF_COOKIE`.
- `where: "auto"` (default) compiles locally when you have unpushed changes and `latexmk` is available,
  otherwise on Overleaf if the cookie is configured, otherwise locally.

The PDF path is included in the result.

### Co-authors and conflicts

TexMex never overwrites work done on Overleaf. `sync_project` and `push_changes` merge Overleaf's newest
version with your pending edits. When both sides changed the same lines, nothing is pushed and the
affected files get standard Git conflict markers:

```text
<<<<<<< HEAD
your version
=======
the version on Overleaf
>>>>>>> refs/remotes/origin/master
```

The agent edits the file to the intended text and calls `push_changes` again (it refuses while markers
remain). `discard_changes` with `all: true` abandons the local edits instead.

With a Git token, each push is one commit on top of Overleaf's history with the message you give, and
Git itself rejects the push if Overleaf changed in the meantime. In free mode, TexMex downloads and
merges Overleaf's latest version immediately before uploading, then uploads each changed file (which
replaces that file on Overleaf, keeping its history). A co-author typing in **the same file** during
those few seconds could have their newest keystrokes replaced, so push when you are not both editing
the same file at that moment.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OVERLEAF_COOKIE` | — | `overleaf_session2` cookie value (or a full `Cookie:` header). Enough on its own with a free account: sync, push, project list, name lookup, compiling on Overleaf. |
| `OVERLEAF_GIT_TOKEN` | — | Optional Overleaf Git token (paid plans): sync through the Git bridge instead. |
| `OVERLEAF_SYNC_MODE` | `auto` | `git` (Git bridge), `web` (cookie) or `auto` (git if a token is set, else web). Applies to projects downloaded from now on. |
| `OVERLEAF_PROJECTS` | — | Aliases: `thesis=<id or URL>,paper=<id>` or JSON `{"thesis": "<id>"}`. |
| `OVERLEAF_URL` | `https://www.overleaf.com` | Base URL of Overleaf (change for Server Pro). |
| `OVERLEAF_GIT_URL` | `https://git.overleaf.com` | Git bridge base URL. For Server Pro defaults to `<OVERLEAF_URL>/git`. |
| `TEXMEX_WORKDIR` | `~/.texmex` | Where working copies (`projects/`) and build output (`builds/`) are stored. |
| `TEXMEX_READ_ONLY` | `false` | `true` removes every tool that edits files or pushes. |
| `TEXMEX_AUTO_SYNC_SECONDS` | `300` | Re-fetch from Overleaf before a tool runs if the last fetch is older than this; `0` disables automatic fetching. Only fast-forwards; never merges on its own. (In free mode each fetch downloads the project zip.) |
| `TEXMEX_GIT_AUTHOR_NAME` / `TEXMEX_GIT_AUTHOR_EMAIL` | your git config | Author of local commits (Overleaf attributes changes to your account either way). |
| `TEXMEX_LATEXMK` | `latexmk` | Path to `latexmk`. |
| `TEXMEX_COMPILE_TIMEOUT_SECONDS` | `180` | Local compile timeout. |
| `TEXMEX_GIT_TIMEOUT_SECONDS` | `300` | Timeout for git operations. |
| `TEXMEX_ALLOW_LATEXMKRC` | `false` | Let local compiles read `latexmkrc` files (see Security). |

**Self-hosted Overleaf**: set `OVERLEAF_URL=https://overleaf.example.edu` (and use the `overleaf.sid`
cookie). With Server Pro's Git bridge, it is assumed at `https://overleaf.example.edu/git` unless you set
`OVERLEAF_GIT_URL`.

**Tip**: if you want the agent's own file tools (or your editor) to see the working copies, point
`TEXMEX_WORKDIR` at a folder inside your workspace, e.g. `TEXMEX_WORKDIR=~/papers/.texmex`.

## Security

- The Git token is passed to git through environment configuration scoped to the Overleaf Git host; it
  is not stored in `.git/config`, not placed on the command line and scrubbed from error messages. The
  session cookie is only sent to `OVERLEAF_URL` (and its sibling subdomains, e.g. a separate real-time
  host), never to other sites such as the PDF download domain.
- File tools are confined to the project: absolute paths, `..`, symlinks leaving the project and the
  `.git` directory are rejected.
- Local compiles run on a copy of the project with **shell escape disabled** and **without
  `latexmkrc`** files, because a `latexmkrc` is Perl code that anyone with write access to the project
  could have added. Set `TEXMEX_ALLOW_LATEXMKRC=true` only for projects you trust. Packages that need
  shell escape (e.g. `minted`) should be compiled on Overleaf.
- `TEXMEX_READ_ONLY=true` gives an agent read and compile access only.
- Pushing is an outward-facing action: collaborators see the changes immediately. The server's
  instructions tell agents to confirm with you before pushing.

## Troubleshooting

- **"Overleaf rejected the Git token"** — generate a new token; tokens can be revoked or expire.
- **"403 / Access denied"** — with a Git token: the plan has no Git integration, or you are not a
  collaborator. Remove the token to use the free cookie mode.
- **"rate-limiting downloads"** — Overleaf allows about 10 project downloads per minute; wait a minute.
- **Free mode stopped working after an Overleaf update** — it relies on the editor's internal endpoints;
  please open an issue with the error message.
- **"The Overleaf session cookie is invalid or has expired"** — copy a fresh `overleaf_session2` value.
- **Tool calls time out in Codex** — raise `tool_timeout_sec` (see above); the first clone of a big
  project and compiles can take a while.
- **Behind a corporate proxy** — git honours `HTTPS_PROXY`; for the cookie features on current Node 22/24 releases, also
  set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses it.
- Local copies are ordinary Git repositories under `TEXMEX_WORKDIR/projects/<id>`; deleting one is safe
  once its changes are pushed (TexMex re-clones on next use).

## Development

```bash
npm install
npm run build        # compile TypeScript to dist/
npm test             # vitest; fake Overleaf: bare repos, a git http-backend, and an in-memory website
npm run typecheck
npm run smoke        # start dist/index.js over stdio and list its tools, like an MCP client
```

The tests need `git`; the local-compile tests additionally need `latexmk` and are skipped without it.
Source layout:

| File | Purpose |
| --- | --- |
| `src/server.ts` | MCP tool and prompt definitions |
| `src/workspace.ts` | Git working copy: clone, sync/merge, push, status, diff, history |
| `src/context.ts` | Project resolution (IDs, URLs, names, aliases) and per-project locking |
| `src/transport.ts` | Syncing with Overleaf: Git bridge, or zip download + upload (free mode) |
| `src/overleafWeb.ts` | Session-cookie client: projects, zip, uploads/deletes, real-time file tree, compiling |
| `src/compile.ts` | Local `latexmk` runs, Overleaf compiles, result formatting |
| `src/latexLog.ts` | LaTeX / BibTeX / Biber log parser |
| `src/outline.ts` | LaTeX structure extraction and static checks |

## Limitations

- Free mode, listing projects by name and compiling on Overleaf use the Overleaf editor's own,
  undocumented endpoints (verified against Overleaf's open-source code, but Overleaf can change them).
- Only files are synced. Project settings (compiler, main document), comments, tracked changes and chat
  are not accessible.
- In free mode a rename is uploaded as a new file plus a deletion, so that file's Overleaf history
  starts over.
