# Listing the MCP server in the directories

How `@bootrfun/mcp` gets found without anyone reading Bootr's docs: the copy to paste, the files in the repository that
the directories read, how each directory takes a server today, and the owner's steps in order. Publishing, logging in
and submitting are the owner's; nothing here was submitted.

Everything about the directories was read on **2026-11-13**; each claim names its source in section 3, and what could
not be confirmed is listed in section 7. Directories change their rules often: read the source again before a step
that depends on it.

## 1. Listing copy

Use these as they are. They follow the public copy rules: plain English, what the server does, nothing that is not
built, no talk of prices or returns.

| Field | Text |
| --- | --- |
| Short name | Bootr |
| Name in the official registry | `fun.bootr/mcp` |
| npm package | `@bootrfun/mcp` |
| One line (97 characters) | Read Bootr coins and AI agents on Base; prepare launches and fee claims as unsigned transactions. |
| Website | https://bootr.fun/docs/api#developer-tools |
| Repository | https://github.com/dnebayis/bootr (the server is in `packages/mcp`) |
| License | MIT (`packages/mcp/LICENSE`) |
| Language, transport | TypeScript, stdio, runs on the user's machine with Node 20 or later |

**Longer description (486 characters)**

> Bootr is a launchpad on Base where every coin comes with an AI agent. This server lets your AI client read coins,
> agents, fees and holdings, and prepare a coin launch or a fee claim as unsigned transactions that your own wallet
> signs. If you launched a coin with your own agent, the same server lets your client run that agent: read mentions,
> post on X and look after its treasury, inside limits Bootr enforces. It runs on your machine, needs no API key and
> never asks for a wallet key.

**Categories and tags**

- Category, where one must be picked: Finance (in `punkpeye/awesome-mcp-servers`: "Finance & Fintech"). Where there
  is a crypto or blockchain category, that one.
- Tags: `base`, `crypto`, `launchpad`, `ai-agents`, `tokens`, `unsigned-transactions`, `x`, `social`.

**Install lines** (the same as in `packages/mcp/README.md`)

Claude Code:

```sh
claude mcp add bootr -- npx -y @bootrfun/mcp
```

Claude Desktop (Settings, Developer, Edit Config) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "bootr": {
      "command": "npx",
      "args": ["-y", "@bootrfun/mcp"]
    }
  }
}
```

OpenAI Codex CLI:

```sh
codex mcp add bootr -- npx -y @bootrfun/mcp
```

**What it can and cannot do**

> The server runs on your own machine and talks to bootr.fun only. It needs no API key and no account. It can read
> public Bootr data (coins, agents, fees, holdings, the activity feed) and it can build the transactions for a coin
> launch or a fee claim and hand them back unsigned: nothing is signed or sent, your own wallet does that if you
> decide to. It never asks for a private key or a seed phrase and has no field to take one; text shaped like a key is
> refused before any request is made. For a coin launched with its own agent, and only after its creator approves
> this client in the browser with their wallet, it can act as that coin's agent: read and post on X, keep the agent's
> notes, pay for web services from the agent's own balance inside the creator's caps, and move the agent's treasury
> inside limits enforced on chain. It cannot move the agent's money anywhere else, change a coin's settings or
> approve anything for the creator. The one secret it keeps is that connection, in a file only you can read; it is
> never shown in a result. Apart from that file, the only place it reads on your machine is one folder for pictures.
> Text written by other people (coin names, posts, mentions, web pages) is marked as data, never as instructions.

**Settings** (none is required, none is a secret): `BOOTR_SITE_URL`, `BOOTR_CREDENTIALS_FILE`, `BOOTR_PICTURES_DIR`,
as the README's table says.

**Logo and icon files in the repository** (no artwork was made for this)

| File | What it is | Public URL |
| --- | --- | --- |
| `apps/web/public/favicon.svg` | The Bootr mark, 24 by 24 units, dark on light and white on dark by itself | https://bootr.fun/favicon.svg |
| `apps/web/public/bootr-mascot-wave.png` | The mascot, 480 by 480 PNG, transparent background | https://bootr.fun/bootr-mascot-wave.png |
| `apps/web/public/og.png` | The share card, 1200 by 630 PNG | https://bootr.fun/og.png |

There is no square PNG of the mark alone. A directory that wants a PNG logo of a fixed size (Cline asks for 400 by
400) needs one made first.

**The line for `punkpeye/awesome-mcp-servers`** (section "Finance & Fintech"; the Glama path is the one Glama gives
the listing, check it before pasting):

```md
- [dnebayis/bootr](https://github.com/dnebayis/bootr) [![dnebayis/bootr MCP server](https://glama.ai/mcp/servers/dnebayis/bootr/badges/score.svg)](https://glama.ai/mcp/servers/dnebayis/bootr) 🎖️ 📇 ☁️ 🍎 🪟 🐧 - Bootr, a launchpad on Base where every coin has an AI agent: read coins, agents and fees, prepare launches and fee claims as unsigned transactions, and run your own coin's agent. Holds no wallet key.
```

## 2. What is in the repository for this

| File | What it is for |
| --- | --- |
| `packages/mcp/server.json` | The listing the official registry stores: name, title, one line, version, the npm package, stdio, the three settings, two icons. Valid against the schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`. |
| `packages/mcp/package.json`, `mcpName` | The registry's proof that the npm package and the listing belong together. It must equal `name` in `server.json`. |
| `packages/mcp/src/listing.test.ts` | Fails when `server.json`, `package.json` and `VERSION` in `src/index.ts` disagree on the version, when the SDK and the CLI are at another version, when the two names differ, when the one line passes 100 characters, or when the listed settings are not exactly the `BOOTR_*` names the code reads. |

`server.json` stays out of the npm package (`files` is `dist`, `README.md`, `LICENSE`). The registry takes it from the
folder `mcp-publisher publish` is run in; from npm it reads one field, `mcpName`, in the metadata of the exact version
`server.json` names.

**Why 0.2.1.** `@bootrfun/mcp@0.2.0` on npm has no `mcpName`, and a published version cannot be changed. The registry
refuses a listing whose npm version lacks the field, so the listing needs a new npm version. The three packages move
together, as before: `@bootrfun/sdk`, `@bootrfun/cli` and `@bootrfun/mcp` are at 0.2.1 in the repository and not
published yet. Nothing else changed in the SDK and the CLI.

**The name: `fun.bootr/mcp`.** The registry has two kinds of name. `io.github.<user>/<name>` is proved by logging in
with GitHub; `<reversed domain>/<name>` is proved with a key whose public half is published on the domain. The
repository is under a personal GitHub account, so the GitHub form would be `io.github.dnebayis/bootr`: a personal
handle in the name every directory shows, and a name that cannot follow the project if the repository ever moves. The
domain form carries the brand, matches the npm scope and the X handle, and stays true wherever the code lives. A
registry name cannot be renamed, and `mcpName` is frozen into each npm version, so this is decided once. The cost is
one DNS record and one key file to keep (section 4, B).

If you would rather use GitHub: before the npm publish, change `mcpName` in `packages/mcp/package.json` and `name` in
`packages/mcp/server.json` to `io.github.dnebayis/bootr`, run the tests, and in section 4 replace steps B2 to B4 with
`mcp-publisher login github`. After 0.2.1 is on npm the name can only change with another npm version.

**DNS, not a file on the site.** The domain can be proved with a TXT record on `bootr.fun` or with a file served at
`https://bootr.fun/.well-known/mcp-registry-auth`. The record was chosen and no route was added to the site: the
registry fetches the file from Google Cloud with a plain client and does not follow redirects, and a firewall or bot
rule at Cloudflare that stops it makes the login fail with a 401 that says little. A TXT record has no such way to
fail and needs no release of the site.

## 3. The directories, and how each takes a server today

| Directory | How it takes a server | What it needs from us | Hosting needed |
| --- | --- | --- | --- |
| Official MCP registry (`registry.modelcontextprotocol.io`) | The `mcp-publisher` command line tool: `login`, then `publish` | `server.json`, `mcpName` in the published npm version, proof of the name (the DNS record) | No |
| Glama (`glama.ai/mcp/servers`) | "Add Server" on the site, by GitHub repository; it also indexes repositories by itself | A public GitHub repository, a license GitHub detects, a Dockerfile set up on Glama's own page so its check can start the server | No (Glama runs the check) |
| `punkpeye/awesome-mcp-servers` | A pull request adding one line to `README.md` | A Glama listing with a score, the Glama badge in the line, the permitted emoji tags, link text of the form `owner/repo` | No |
| mcp.so | The form at `mcp.so/submit` | Repository URL and a name; a paid option publishes at once | No |
| PulseMCP | Closed. It says it will take servers from the official registry by itself when it reopens | The official registry listing | No |
| GitHub MCP Registry (`github.com/mcp`) | Publish to the official registry, then ask by email | The official registry listing | No |
| mcpservers.org (optional) | The form at `mcpservers.org/submit` | Name, category, one line, a link; a field for the official registry name | No |
| Cline MCP Marketplace (optional) | An issue in `cline/mcp-marketplace` | Repository URL, a 400 by 400 PNG logo, a reason; extra checks for crypto tools | No |
| Smithery | No way in found | | |
| Anthropic's directory (Claude) | Not open to this server | | |
| `modelcontextprotocol/servers` | No list any more | | |

### Official MCP registry

- A server that is an npm package is published with the `mcp-publisher` tool: `init` (writes a template; ours is
  written already), `login`, `publish`, `validate` ("Validate server.json without publishing"), `status`, `logout`.
  Install: `brew install mcp-publisher`, or the binary from the releases of `modelcontextprotocol/registry` (latest
  release v1.8.9, 2026-11-10).
- The current schema is `2025-12-11`: every example in the docs uses it, the tool's source names it as current
  (`pkg/model/constants.go`), and the changelog has only an unreleased draft above it.
  Required: `name`, `description` (at most 100 characters), `version`. A package needs `registryType`, `identifier`,
  `transport`; for npm the registry also needs `version`, and `latest` or a range is refused.
- For npm it reads `https://registry.npmjs.org/<package>/<version>` and compares `mcpName` with the listing's name.
  A missing field or another value refuses the publish. Only the public npm registry is accepted.
- Names: `io.github.<user>/…` with GitHub login (an organisation's name only for its owners, and not through the
  interactive login at the moment); a domain name with a DNS TXT record or a file at
  `/.well-known/mcp-registry-auth`, both of the form `v=MCPv1; k=ed25519; p=<public key>`. The TXT record goes on the
  domain itself, not on a name such as `_mcp-auth.bootr.fun`.
- A version, once published, cannot be changed. An update is a new `server.json` with a new version string. The docs
  say to keep the listing's version equal to the package's.
- The registry is still called a preview: "Breaking changes or data resets may occur".
- A server can be marked deleted (`mcp-publisher status --status deleted …`); it is hidden, never erased.

Sources (repository `modelcontextprotocol/registry`, branch `main`, read 2026-11-13):
`docs/modelcontextprotocol-io/quickstart.mdx`, `authentication.mdx`, `package-types.mdx`, `versioning.mdx`, `faq.mdx`,
`github-actions.mdx`, `registry-aggregators.mdx`; `docs/reference/server-json/official-registry-requirements.md` and
`CHANGELOG.md`; `internal/validators/registries/npm.go` and `internal/validators/validators.go` for what is checked.

### Glama

- Servers are listed by GitHub repository. The site has an "Add Server" button; Glama also lists repositories it
  finds by itself. Each listing shows grades for license, quality and maintenance.
- The maintainer of Glama also runs `awesome-mcp-servers`, and that list's own check says what Glama needs: "you must
  add Dockerfile directly to Glama. For checks to pass, we only need the server to start and respond to introspection
  requests". The Dockerfile is set up on Glama's page for the listing, not committed to the repository.
- Claiming a listing: for a repository under a personal account, signing in to Glama with that GitHub account is
  enough. `glama.json` (a list of maintainers at the repository root) is for repositories owned by an organisation.
  Ours is under a personal account, so no `glama.json` was added.
- Our server starts in about a second with no settings and answers the tool list (46 tools on bootr.fun today: 13
  read and prepare tools, 33 for running a coin's agent, and one prompt), so the check has what it asks for.

Sources: `.github/workflows/check-glama.yml` in `punkpeye/awesome-mcp-servers` (the comment the check posts);
https://glama.ai/blog/2025-07-08-what-is-glamajson; https://glama.ai/mcp/servers;
https://glama.ai/blog/2026-04-03-tool-definition-quality-score-tdqs. All read 2026-11-13.

### punkpeye/awesome-mcp-servers

- A pull request that adds one line to `README.md`, in the right section, in alphabetical order.
- The repository's check labels a pull request by four things: a Glama badge in the new line
  (`glama.ai/mcp/servers/…/badges/score.svg`), at least one permitted emoji and no other emoji, link text that
  contains a slash (`owner/repo`), and a first link that points to `github.com`. Without the badge it asks for a
  Glama listing that passes its checks.
- The list is for servers "with a public GitHub repository" that one installs and runs; ours qualifies.
- A pull request opened by an agent may add `🤖🤖🤖` to its title for a faster merge. Opening it is the owner's.

Sources: `CONTRIBUTING.md`, `README.md` (legend and sections) and `.github/workflows/check-glama.yml` of the
repository, read 2026-11-13.

### mcp.so

The form at https://mcp.so/submit takes a type (MCP Server), a repository URL and a name. A paid option publishes at
once with a badge; the free one goes through a review, which the page implies and does not describe. Read 2026-11-13.

### PulseMCP

https://www.pulsemcp.com/submit (last updated 2026-09-03): "We are not accepting new MCP server or client submissions
right now". It recommends the official registry as the first step in any case and says it will pick up registry
servers by itself once it resumes. Nothing to submit.

### GitHub MCP Registry

GitHub's own post (2025-10-24, "How to find, install, and manage MCP servers with the GitHub MCP Registry") says to
publish to the official registry with `mcp-publisher` and then "email partnerships@github.com and request for your
server to be included"; updates then follow by themselves. It announced self-publication for later. Whether the email
is still needed in November 2026 was not confirmed.

### mcpservers.org and the Cline marketplace (optional)

- https://mcpservers.org/submit: name, category, short description, a link, the official registry name (optional),
  an email. Free: "Review within 2 weeks". A paid review exists.
- `cline/mcp-marketplace`: an issue from its template with the repository URL, a 400 by 400 PNG logo and a reason.
  It reviews adoption, the maintainer, maturity and security, and says it will "require additional verification for
  cryptocurrency-related tools". Worth doing only once there is a logo file of that size.

### Smithery: no way in

Smithery's own notice (https://smithery.ai/future, read 2026-11-13): on 2026-10-31 it shut down its accounts, API
keys, command line tool and hosted server addresses, and stays as "a public (non-proxied) MCP registry" with "a
curated set of verified servers", now run by Arcade. Its publishing docs answer 404. There is no form, no
`smithery.yaml` flow and no command to publish with any more, so no `smithery.yaml` was added.

### Anthropic's directory: not open to this server

- Local servers packaged as `.mcpb` bundles are no longer accepted: "desktop extension listings in the directory are
  deprecated, and the directory no longer accepts local servers packaged as MCP Bundles". A local server can only be
  listed inside a plugin; the connector route needs a remote `https://` server.
- The directory's policy says: "We do not generally allow cryptocurrency software in our directory", and lists
  software that "transfers money or other financial assets" among the unsupported uses. That covers plugins too.
- So no `.mcpb` manifest and no plugin were added, and there is nothing to submit unless Anthropic agrees in writing.

Sources: https://claude.com/docs/connectors/building/submission.md, https://claude.com/docs/plugins/submit.md,
https://claude.com/docs/plugins/pre-submission-checklist.md,
https://claude.com/docs/connectors/building/review-criteria.md,
https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy. Read 2026-11-13.

### modelcontextprotocol/servers

Its README no longer has a community list. It holds the reference servers only and says: "If you are looking for a
list of MCP servers, you can browse published servers on the MCP Registry". Nothing to submit. Read 2026-11-13.

## 4. The owner's checklist

In this order. B needs A, and the directories in F copy from B. C, D and E read the repository and can be done at
any time, but an install from them gives 0.2.0 until A is done.

### A. Release 0.2.1 on npm (needed before B)

1. Merge this branch to `main` and push.
2. Publish the three packages in the usual order, each from its folder, the way 0.2.0 was published (with pnpm, so
   that `workspace:^` becomes a real version): `packages/sdk`, then `packages/cli`, then `packages/mcp`.

   ```sh
   pnpm publish
   ```

3. Check that npm carries the field the registry reads. It must print `fun.bootr/mcp`:

   ```sh
   npm view @bootrfun/mcp@0.2.1 mcpName
   ```

### B. The official registry (needs A)

1. Install the tool and check it runs:

   ```sh
   brew install mcp-publisher
   mcp-publisher --help
   ```

2. Make the key once, and keep it: every later version needs it again. The Mac's own `openssl` cannot make this kind
   of key; Homebrew's can, and it is installed on this machine. Keep the file out of the repository.

   ```sh
   OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
   $OPENSSL genpkey -algorithm Ed25519 -out ~/.ssh/bootr_mcp_registry.pem
   chmod 600 ~/.ssh/bootr_mcp_registry.pem
   echo "v=MCPv1; k=ed25519; p=$($OPENSSL pkey -in ~/.ssh/bootr_mcp_registry.pem -pubout -outform DER | tail -c 32 | base64)"
   ```

   The last line prints the record, for example `v=MCPv1; k=ed25519; p=AbC…=`. It is public; the `.pem` file is not.

3. Add the record at Cloudflare (the domain's DNS is there): `bootr.fun`, DNS, Records, Add record. Type `TXT`, name
   `@`, content the printed line, TTL Auto. Leave the existing SPF record as it is. Then check that it is visible:

   ```sh
   dig TXT bootr.fun +short
   ```

4. Log in, from the package's folder. The login lasts about five minutes, so go on to the next step at once.

   ```sh
   cd packages/mcp
   OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
   MCP_PRIVATE_KEY="$($OPENSSL pkey -in ~/.ssh/bootr_mcp_registry.pem -noout -text | sed -n '/priv:/,/pub:/p' | sed '1d;$d' | tr -d ' :\n')" \
     mcp-publisher login dns --domain bootr.fun
   ```

5. Check and publish, in the same folder:

   ```sh
   mcp-publisher validate
   mcp-publisher publish
   ```

6. See it in the registry:

   ```sh
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=fun.bootr/mcp"
   ```

If the publish says "Registry validation failed for package", step A3 did not print the name. If the login fails with
a signature error, compare the "Expected proof record" it prints with what `dig` shows.

### C. Glama (works without A and B)

1. Decide two things first.
   - **The license.** The repository has no `LICENSE` at its root (GitHub reports none); only the three packages carry
     MIT. Glama's license grade follows what GitHub detects for the repository, so it will be missing unless a
     license is put at the root, which is a decision about the whole codebase.
   - **Which README people land on.** Glama, mcp.so and the awesome list show a repository, and this repository's
     front page is the developer README of the whole project, not `packages/mcp/README.md`. Listing the monorepo
     works; a small public repository holding only the MCP package would read better. Not done here.
2. Open https://glama.ai/mcp/servers, sign in with the GitHub account that owns the repository, and look for
   `dnebayis/bootr`. If it is not there, use "Add Server" and give `https://github.com/dnebayis/bootr`.
3. Signing in with that account claims the listing. On the listing's admin page set up the Dockerfile so that it
   installs Node 20 or later and starts the server with `npx -y @bootrfun/mcp`. No setting is needed.
4. Wait for the check to pass and for the score page to show grades. Note the listing's path (expected
   `dnebayis/bootr`); the badge in D uses it.

### D. punkpeye/awesome-mcp-servers (needs C)

1. Fork https://github.com/punkpeye/awesome-mcp-servers and add the line from section 1 to `README.md` under
   "Finance & Fintech", in alphabetical order. Correct the two Glama paths in it if Glama gave the listing another one.
2. Open the pull request with a plain title, for example "Add dnebayis/bootr". Answer what the check's comments ask.

### E. mcp.so (works without A and B)

1. Open https://mcp.so/submit, choose "MCP Server", give `https://github.com/dnebayis/bootr` and the name `Bootr`.
2. Use the free submission unless you want the paid one; the page shows the price.

### F. Directories that follow the registry (need B)

1. PulseMCP: nothing to do. Look for the listing at https://www.pulsemcp.com/servers once it reopens.
2. GitHub MCP Registry: look for Bootr at https://github.com/mcp a few days after B. If it is not there, write to
   partnerships@github.com, name the registry entry `fun.bootr/mcp` and ask for it to be included.
3. Optional: https://mcpservers.org/submit with the copy of section 1 and the registry name `fun.bootr/mcp`.

### Not to do

- Smithery: there is no way to submit.
- Anthropic's directory: do not submit; its policy does not take cryptocurrency software.
- `modelcontextprotocol/servers`: no list to be added to.

## 5. A later version

1. Change the version in `packages/sdk/package.json`, `packages/cli/package.json`, `packages/mcp/package.json`,
   `VERSION` in `packages/mcp/src/index.ts` and both `version` fields of `packages/mcp/server.json`.
   `pnpm --filter @bootrfun/mcp test` fails while any of them differs.
2. Publish to npm (A2, A3).
3. Log in and publish to the registry again (B4, B5). The key and the DNS record stay as they are.
4. Glama, mcp.so and the awesome list follow the repository; nothing to send.

A change to the listing alone (the one line, an icon, a setting) also needs a new version string, because a published
version cannot be edited. Make it with the next release of the packages.

## 6. What makes a listing read well, by each directory's own words

- **Official registry.** The one line is capped at 100 characters and "should focus on capabilities, not
  implementation details". `title` is what directories may show instead of the name. `repository` is "recommended for
  transparency and security inspection". Icons must be `https` and PNG or JPEG is what every client must support.
  The docs ask for semantic versions and for the listing's version to equal the package's. All of that is in
  `server.json`.
- **Glama.** Grades for license, quality and maintenance on every listing, and a score for how tools are defined, in
  six parts: purpose, when to use it, what it does to the world, what each parameter means, brevity, completeness.
  The fix it names most is a description that does not set a tool apart from its neighbours. Our tools each have a
  title and a hint that says whether they only read or also act; the longest name is 31 characters.
- **awesome-mcp-servers.** "Write concise and informative descriptions", one server per line, the existing format
  kept exactly.
- **Anthropic's review criteria** (not a place we can list, but the clearest written standard): every tool has a
  `title` and a read-only or destructive hint, names are at most 64 characters, descriptions say what the tool does
  and when to use it and do not tell the model how to behave, reads and writes are separate tools.
- **Cline.** A client given only the README must be able to install the server.

## 7. Not confirmed

- `mcp-publisher validate` was not run here (the tool is not installed, and installing it is the owner's). By its
  source it needs no login. `server.json` was checked against the downloaded schema instead, and against the
  registry's own rules by reading its code.
- Glama: the fields of the "Add Server" form, the exact form of its Dockerfile page, how soon a new repository gets
  a score, and that the license grade reads GitHub's detected license (seen on one Glama score page, not in a doc).
  Whether Glama also copies listings from the official registry is said by others, not by Glama's pages read here.
- The Glama path of the listing (`dnebayis/bootr` is the usual form).
- mcp.so: whether a sign-in is needed and how long the free review takes.
- GitHub MCP Registry: whether inclusion still needs the email. The source is a year old.
- Smithery: whether Arcade takes requests to add a server to the curated set. No page says so.
- Whether Anthropic would allow this server in writing; the policy leaves that door open and nothing was asked.
- Cursor's own directory (`cursor.directory`) was not read: the page answered 429.
