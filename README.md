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

## How it works

Overleaf offers a [Git integration](https://www.overleaf.com/learn/how-to/Git_integration): every
project can be cloned from `https://git.overleaf.com/<project-id>`. TexMex keeps a local working copy of
each project (in `~/.texmex/projects/<id>`), the agent's tools operate on it, and `push_changes` commits
and pushes to Overleaf, merging any edits made on Overleaf in the meantime. Edits made in the Overleaf
editor appear in the project's Git history, so TexMex picks them up on the next sync (tools also re-fetch
automatically every few minutes).

Things Git cannot do — listing your projects by name and compiling on Overleaf — use an optional
browser session cookie.

## Requirements

- **Node.js 20+** and **git**.
- An Overleaf account with **Git integration**. This is a premium feature on overleaf.com (included in
  paid plans and most institutional licenses) and is available on Overleaf Server Pro.
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

### Git token (required)

In Overleaf open **Account Settings → Git Integration → Generate token** and copy the token (it starts
with `olp_`). Provide it to TexMex as `OVERLEAF_GIT_TOKEN`. The token is sent only to the Overleaf Git
host; it is never written into the working copies' `.git/config`.

### Session cookie (optional)

Setting `OVERLEAF_COOKIE` enables `list_projects` for your whole account, referring to projects by
name, and compiling on Overleaf. To get it: log in to Overleaf in your browser, open the developer tools
→ *Application* (Chrome) or *Storage* (Firefox) → *Cookies* → `https://www.overleaf.com`, and copy the
value of `overleaf_session2`.

> The cookie is as powerful as your password for as long as the session lives. Keep it out of files you
> commit, and log out of that browser session to revoke it. The web endpoints TexMex uses are the ones
> the Overleaf editor uses; they are not an official API and may change.

## Connect it to your agent

In the examples, replace `/path/to/TexMex` with the absolute path of your clone.

### Claude Code

```bash
claude mcp add overleaf --scope user \
  --env OVERLEAF_GIT_TOKEN=olp_your_token \
  --env OVERLEAF_COOKIE=your_overleaf_session2_value \
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
      "env": {
        "OVERLEAF_GIT_TOKEN": "${OVERLEAF_GIT_TOKEN}",
        "OVERLEAF_COOKIE": "${OVERLEAF_COOKIE}"
      }
    }
  }
}
```

Run `/mcp` inside Claude Code to check that the `overleaf` server is connected. The two bundled prompts
are available as `/mcp__overleaf__fix_compile_errors` and `/mcp__overleaf__review_recent_changes`.

### OpenAI Codex

```bash
codex mcp add overleaf \
  --env OVERLEAF_GIT_TOKEN=olp_your_token \
  --env OVERLEAF_COOKIE=your_overleaf_session2_value \
  -- node /path/to/TexMex/dist/index.js
```

or add it to `~/.codex/config.toml` directly:

```toml
[mcp_servers.overleaf]
command = "node"
args = ["/path/to/TexMex/dist/index.js"]
env = { OVERLEAF_GIT_TOKEN = "olp_your_token", OVERLEAF_COOKIE = "your_overleaf_session2_value" }
# Cloning a large project or compiling can take longer than Codex's 60 s default.
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
      "env": { "OVERLEAF_GIT_TOKEN": "olp_your_token" }
    }
  }
}
```

### Check the setup

```bash
OVERLEAF_GIT_TOKEN=olp_your_token node /path/to/TexMex/dist/index.js check https://www.overleaf.com/project/<id>
```

`check` verifies git, the working directory, the token (by contacting the project's Git remote), the
cookie and `latexmk`, and explains what to fix.

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
| `get_history` | Recent commits (including edits made in the Overleaf editor) with changed files |
| `compile` | Compile locally (`latexmk`) or on Overleaf; parsed errors/warnings with locations |
| `get_compile_log` | Tail of the raw log of the last compile, or lines matching a pattern |
| `write_file` | Create or overwrite a text file |
| `edit_file` | Replace an exact, unique piece of text (or all occurrences) |
| `delete_file` / `move_file` | Delete or move/rename files and folders |
| `import_file` | Copy a file from your computer (e.g. a generated figure) into the project |
| `push_changes` | Commit all pending changes and push them to Overleaf, merging co-authors' edits first |
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
remain). `discard_changes` with `all: true` abandons the local edits instead. Each push becomes a single
commit on top of Overleaf's history with the message you give.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OVERLEAF_GIT_TOKEN` | — | Overleaf Git token. Required to download and push projects. |
| `OVERLEAF_COOKIE` | — | `overleaf_session2` cookie value (or a full `Cookie:` header). Enables account project list, name lookup and compiling on Overleaf. |
| `OVERLEAF_PROJECTS` | — | Aliases: `thesis=<id or URL>,paper=<id>` or JSON `{"thesis": "<id>"}`. |
| `OVERLEAF_URL` | `https://www.overleaf.com` | Base URL of Overleaf (change for Server Pro). |
| `OVERLEAF_GIT_URL` | `https://git.overleaf.com` | Git bridge base URL. For Server Pro defaults to `<OVERLEAF_URL>/git`. |
| `TEXMEX_WORKDIR` | `~/.texmex` | Where working copies (`projects/`) and build output (`builds/`) are stored. |
| `TEXMEX_READ_ONLY` | `false` | `true` removes every tool that edits files or pushes. |
| `TEXMEX_AUTO_SYNC_SECONDS` | `300` | Re-fetch from Overleaf before a tool runs if the last fetch is older than this; `0` disables automatic fetching. Only fast-forwards; never merges on its own. |
| `TEXMEX_GIT_AUTHOR_NAME` / `TEXMEX_GIT_AUTHOR_EMAIL` | your git config | Author of pushed commits (Overleaf attributes pushes to the token's account). |
| `TEXMEX_LATEXMK` | `latexmk` | Path to `latexmk`. |
| `TEXMEX_COMPILE_TIMEOUT_SECONDS` | `180` | Local compile timeout. |
| `TEXMEX_GIT_TIMEOUT_SECONDS` | `300` | Timeout for git network operations. |
| `TEXMEX_ALLOW_LATEXMKRC` | `false` | Let local compiles read `latexmkrc` files (see Security). |

**Self-hosted Overleaf (Server Pro)**: set `OVERLEAF_URL=https://overleaf.example.edu`; the Git bridge is
assumed at `https://overleaf.example.edu/git` unless you set `OVERLEAF_GIT_URL`.

**Tip**: if you want the agent's own file tools (or your editor) to see the working copies, point
`TEXMEX_WORKDIR` at a folder inside your workspace, e.g. `TEXMEX_WORKDIR=~/papers/.texmex`.

## Security

- The Git token is passed to git through environment configuration scoped to the Overleaf Git host; it
  is not stored in `.git/config`, not placed on the command line and scrubbed from error messages. The
  session cookie is only ever sent to `OVERLEAF_URL`.
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
- **"403 / Access denied"** — the account has no Git integration (plan) or is not a collaborator.
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
npm test             # vitest; uses local bare repos and a git http-backend as a fake Overleaf
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
| `src/overleafWeb.ts` | Session-cookie client for project listing and compiling on Overleaf |
| `src/compile.ts` | Local `latexmk` runs, Overleaf compiles, result formatting |
| `src/latexLog.ts` | LaTeX / BibTeX / Biber log parser |
| `src/outline.ts` | LaTeX structure extraction and static checks |

## Limitations

- Requires Overleaf's Git integration; free overleaf.com accounts without it cannot sync.
- Only files are synced. Project settings (compiler, main document), comments, tracked changes and chat
  are not accessible through Git.
- Compiling on Overleaf and listing projects by name depend on undocumented web endpoints.
