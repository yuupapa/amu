# Amu MCP market (design)

Status: design, revision 8 (2026-10-08). Review rounds: 1 Red, 2–7 Yellow, 8 Green.
User-facing docs will go to `docs/user/mcp-market.md`.

## Goal

A settings page that lists remote MCP servers. "追加する" connects one once, including a
browser login, and the AIs Amu runs can use it in Amu threads without per-CLI setup.
Terminal use of `claude` / `codex` outside Amu is out of scope.

## First version (v1) scope

- **AIs:** Claude and Codex threads only. Cursor, ACP agents (Grok and others), Pi and
  OpenCode get nothing in v1. The page says so ("Claude と Codex の会話で使えます").
- **Servers:** a fixed catalog, chosen by the user (2026-10-08): Context7 (no login) and
  the OAuth servers with dynamic client registration Vercel, HyperFrames (HeyGen),
  Supabase, Linear and topview. Each is shipped only after a real login, `initialize` and
  `tools/list` have worked against it, and one side-effect-free `tools/call` has gone
  through the proxy from a Claude thread and from a Codex thread; until then it is hidden. GitHub and Google are
  later.
- **Where:** connecting and removing only from the desktop app on this Mac. Phones and
  other clients see the status read-only.
- **Threads:** every Claude and Codex thread's MCP session lists all added servers, but
  the proxy refuses `tools/call` (and any method other than `initialize`, `ping`,
  `tools/list` and notifications) unless the thread's _effective_ policy allows outside
  actions (below), with a JSON-RPC error saying why. Changing the thread's mode makes the
  tools work without reopening the session. One account per server per Amu.
- **Effective policy, per request:** one shared function decides whether a thread is
  read-only, and both the adapters and the proxy call it, so they cannot drift. It is
  extracted from what the adapters do today — Codex: the sandbox decision inside
  `buildCodexTurnStartParams` (approval-required → read-only, plus the injected sandbox
  override service); Claude: the read-only decision used for `claudeMcpQueryOverrides`.
  Its input is the fields it needs (`runtimeMode`, `interactionMode`, provider kind,
  worktree), read per request from the thread shell (as `mcp/threadAccess.ts` does), with
  the override service from the server's layers. On top, Claude's live permission mode,
  published by the Claude adapter to the provider MCP session at query start, on every
  status change, when it restores the mode before the next prompt, and cleared when the
  query ends. Outside actions are refused when: interaction mode is plan; the shared
  function says read-only (so Codex's Supervised mode is refused); or Claude's live mode
  is `plan`. Anything unknown or unreadable counts as refused. Otherwise each AI's own
  permission handling applies unchanged: for Claude that is its actual permission mode,
  including one the user set through Claude's launch arguments (for example
  `bypassPermissions`) and "allow for this session" answers; Amu does not promise a prompt
  per call.
- **When servers apply:** the set of servers is fixed when Amu opens the provider MCP
  session for a thread (the same session that carries t3-code) and kept for that session's
  life. A server added later reaches a thread only once its old MCP credential has been
  released and a new MCP session is opened for it: new threads, and existing threads after
  an Amu restart. Unloading a thread alone is not enough (a shared Codex runtime keeps and
  reuses the credential on re-attach). The card says "これから始める会話で使えます（開いて
  いる会話は Amu の再起動のあと）". Removal takes effect at once: the proxy refuses the
  server even though older sessions still list it.

## Servers probed (2026-10-08, unauthenticated)

| Server      | URL                                      | Login                                                                        |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| Context7    | `https://mcp.context7.com/mcp`           | none                                                                         |
| Vercel      | `https://mcp.vercel.com`                 | OAuth, DCR, scope `openid`                                                   |
| HyperFrames | `https://mcp.heygen.com/mcp/hyperframes` | OAuth (issuer `https://api2.heygen.com`), DCR, scopes `openid profile email` |
| Supabase    | `https://mcp.supabase.com/mcp`           | OAuth (issuer `https://api.supabase.com`), DCR                               |
| Linear      | `https://mcp.linear.app/mcp`             | OAuth, DCR (also client-id metadata documents), scopes `read write`          |
| topview     | `https://mcp-browser.topview.ai`         | OAuth (issuer `https://mcp.topview.ai`), DCR, scope `mcp:tools`              |

Some of these reject requests without a browser-like `User-Agent` (403); the client sends
`User-Agent: Amu/<version>`.

## Catalog entry (server, static)

`{ id, name, description, url, auth: { kind: "none" } | { kind: "oauth-dcr", scopes,
allowedOrigins } }`. `allowedOrigins` lists every HTTPS origin the flow may contact for
this entry (resource, protected-resource metadata, issuer, authorization, token,
registration and revocation endpoints). Nothing outside it is fetched or sent to.

## Connection state

`mcp-market.json` in the server state folder: `{ version, revision, servers: { [id]:
{ addedAt, generation } } }`. Secrets in `ServerSecretStore` under
`amu-mcp-market:<id>`: `{ generation, clientId, clientSecret?, redirectUri, issuer,
tokenEndpoint, accessToken, refreshToken?, expiresAt?, tokenGeneration, authVersion }`.

Status shown: 未追加 / 接続済み / 更新して使えます (access token expired, refresh token
present) / もう一度ログインが必要 (refresh failed or the server rejected the token after a
refresh) / 一時的に使えません (network or 5xx). Status changes caused by a failed request
(もう一度ログインが必要, 一時的に使えません) are applied only if the `generation`,
`authVersion` and `tokenGeneration` that request used are still current; a late answer
to an older request fails only that request. Every added server is listed in a new MCP
session whatever its status; status is checked per request in the proxy, so Amu never
drops a server for a passing problem. Whether a CLI that failed its first `initialize` or
`tools/list` tries again in the same session is up to the CLI; if it does not, a new
thread (or a restart) brings the server back. The card's error text says so.

`generation` rises on every add and remove. `loginAttempt` (memory) rises on every login
start for that server. `authVersion` (stored with the secret) rises on every successful
login commit, also when the server stays added (a re-login does not change
`generation`, so existing proxy credentials keep working). Each connection has one in-process lock. Under it, and only under
it: the generation check plus the secret commit of a callback, token exchange or refresh
(a login commit also requires that its attempt number is still the latest, so an older
callback that finishes after a newer start is dropped; a refresh result — success or
failure — is applied only if `authVersion` and `tokenGeneration` still equal the values it
started from, so a refresh begun before a re-login cannot overwrite or fail the new
login) (network calls run outside the lock; only the commit is
guarded), and removal. A secret is used only when its `generation` equals the state's.
Removal, under the lock, deletes state and secrets, bumps the generation, cancels the
pending login and aborts this server's upstream streams; then it best-effort revokes
upstream (failure does not undo the local removal).

## Login (OAuth 2.1 client, MCP authorization spec)

1. `POST /api/amu/mcp-market/<id>/login` (and `DELETE /api/amu/mcp-market/<id>`) — only
   for the desktop app's own session: the request's authenticated session must have
   subject `desktop-bootstrap`, which only the `desktop-bootstrap` grant issues (both the
   seeded token and the rotating secret-derived token; the trusted IPC channel only the
   Electron app holds; review round 8 confirmed both paths, and that pairing links,
   one-time tokens and T3 Connect use other subjects), with environment write scope and a
   loopback peer address. Someone who can run Amu's own CLI on this Mac (`auth session
issue --subject`) can mint any subject; that local owner is outside this check. A loopback peer alone
   is not enough, because Tailscale serving forwards remote clients to 127.0.0.1, and a
   paired phone or browser has write scope but never a desktop-bootstrap session. Else 403.
2. Discovery: unauthenticated `initialize` → `WWW-Authenticate resource_metadata` →
   protected-resource metadata → authorization-server metadata (RFC 8414, then OIDC
   discovery). Every URL must be HTTPS, in `allowedOrigins`, fetched without following
   redirects, resolved and connected to a validated public IP (the `htmlRender/publicProxy`
   approach). Responses size-capped.
3. Client: reuse the stored registration when issuer and redirect URI match; else DCR
   (RFC 7591, client name "Amu", `token_endpoint_auth_method` from metadata, redirect
   `http://127.0.0.1:<amu port>/api/amu/mcp-market/callback`). A port change re-registers.
4. Attempt record (memory only, one per server). The start raises `loginAttempt` first;
   after discovery and DCR the record is stored only if its number is still the latest
   (an older start that finishes its preparation later is dropped, never replacing a
   newer record): `{ state, attempt, serverId, generation, issuer, resource, clientId, redirectUri, verifier, createdAt }`,
   10-minute lifetime. Authorization URL with PKCE S256, `state`, `resource` (RFC 8707),
   catalog scopes. The desktop opens it in the default browser.
5. `GET /api/amu/mcp-market/callback` — the one route without environment auth. Loopback
   peer only. Looks the attempt up by `state` (constant-time compare); an unknown state is
   rejected without touching other attempts; a known one is consumed atomically once. Code
   exchange with the same redirect URI and verifier. ID tokens are ignored (no OIDC
   login). Page with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a strict CSP,
   and a plain "閉じて Amu に戻ってください".
6. After the exchange: `initialize` + `tools/list` through the same upstream client; only
   then the server shows 接続済み.

## Tokens

Refresh is single-flight per connection inside the server (one Amu server owns its state
folder). A request remembers the `tokenGeneration` it sent; on a 401 it refreshes only if
the stored generation is still that one, else it retries with the newer token. A refresh
response without a refresh token keeps the old one. Without `expires_in` the token is used
until a 401. Upstream challenges are never passed to the AI: a 401 that survives one
refresh marks the connection もう一度ログインが必要 and the AI gets a JSON-RPC error telling
the user to log in again in Amu.

## Proxy

Implementation note: the proxy and the login callback run on their own HTTP server on
127.0.0.1 (port 47823, else any free port), not on the Amu server port, so Tailscale
serving and paired devices cannot reach them at all; the settings routes
(`GET|POST /api/amu/mcp-market`) stay on the Amu server. The per-session credential is
minted the first time an adapter asks for a provider MCP session's servers and is dropped
by the same `McpSessionRegistry` revoke calls that end that session's t3-code credential.

`POST | GET | DELETE /api/amu/mcp-proxy/<id>` on loopback.

- **Credential:** its own bearer, created together with the provider MCP session that the
  session manager already opens per thread for t3-code (`McpProviderSession`), and living
  exactly as long: same reuse across turns and resumes (so Claude's per-turn comparison key
  does not change and no query is recreated), revoked in the same release path. No
  separate clock: it is valid while that MCP session is live. 32 random bytes, in memory,
  bound to `{ environmentId, threadId, providerSessionId, servers }` where `servers` is the
  set of `{ serverId, generation }` fixed at session open. Every request checks that the
  MCP session is still owned and not released (through the session manager's ownership
  and release path, not the t3-code bearer's 24-hour liveness window), that the server's
  current generation equals the one bound (so a session from before a remove stays refused
  after the same server is added again), and the thread's current mode (read-only and plan
  allow only `initialize`, `ping`, `tools/list` and notifications). Only these credentials are accepted — not the t3-code token, not
  Amu's own MCP OAuth clients.
- **Children:** a thread Amu starts itself (delegated task, `t3_thread_launch`) opens its
  own MCP session and so gets its own credential under the same checks. A provider-native
  child (Claude's `Agent` tool, Codex's native subagents) runs inside the parent's CLI
  process and its MCP clients; it uses the parent's credential with the parent's
  permissions. That is the same boundary t3-code tools have today and cannot be split
  without a separate process; it is stated in the docs.
- **Upstream session ids:** the proxy records the `Mcp-Session-Id` that upstream returns for
  a credential and rejects requests carrying any other id. `Last-Event-ID` is passed only
  with that session.
- **Headers:** rebuilt from allowlists both ways. To upstream: `Content-Type`, `Accept`,
  `Mcp-Session-Id`, `MCP-Protocol-Version`, `Last-Event-ID`, `Accept-Encoding: identity`,
  and Amu's `Authorization`. Back: `Content-Type`, `Mcp-Session-Id`, `Cache-Control`.
  Duplicates or malformed values → 400. No `Host`, `Content-Length`, `Transfer-Encoding`,
  cookies or challenges copied.
- **Retries:** one retry only after a plain HTTP 401 status with a refreshed token (upstream
  did not process it). Never after a dropped connection; a POST is not re-sent.
- **Limits:** request body cap as other Amu routes; 15 s to response headers; at most 8 open
  streams per connection and 4 per credential; upstream aborted when the AI disconnects;
  responses streamed with backpressure, no buffering.
- **Logging:** never headers, codes, states, tokens or bodies; adapters' comparison keys
  that contain the proxy credential are not logged.

## Injection (v1)

Both adapters read the market entries from the provider MCP session (fixed at open, see
above), never from live state, so the entries and credential stay identical for the
session's life.

- **Claude** (`claudeMcpQueryOverrides`): `amu-mcp-<id>` → `{ type: "http", url, headers: {
Authorization } }`. Not added to `allowedTools`, so Claude's permission mode applies.
  Because the entries do not change within a session, the per-turn comparison never sees
  a market change, and the background-work replacement error cannot be triggered by it.
- **Codex** (thread config `mcp_servers`): `amu-mcp-<id>` → `{ url, http_headers: {
Authorization } }` (Codex's own shape), sent at start, resume and fork from the session.
  A loaded thread is not resumed again for a market change (the manager skips resume when
  loaded); it picks the change up when Amu next opens its session.
- Names under `amu-mcp-` are reserved; if the user's own Claude or Codex config already has
  that name, Amu skips its entry and shows it on the card.

## Out of v1

Cursor, ACP (would need per-server stdio bridges to the proxy, since ACP agents drop HTTP
MCP even when they advertise it), Pi, OpenCode, GitHub (`gh` token: account switching),
Google (needs an own Google OAuth client), arbitrary URLs, several accounts,
logging in from a phone, per-thread on/off.
