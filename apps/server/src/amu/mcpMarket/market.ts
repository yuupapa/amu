// @effect-diagnostics globalDate:off - a card's expiry is shown against the wall clock.
import { findMcpMarketEntry, MCP_MARKET_CATALOG, mcpMarketServerName } from "./catalog.ts";
import { userTakenMarketNames } from "./conflicts.ts";
import { checkMcpServer } from "./mcpClient.ts";
import { McpMarketLoginError, McpMarketOAuth } from "./oauth.ts";
import { McpMarketProxy, type ProxyCredential, type ProxyHooks } from "./proxy.ts";
import { httpsTransport, type MarketTransport } from "./safeFetch.ts";
import { McpMarketStore } from "./store.ts";

/**
 * Amu MCP market (docs/internals/amu-mcp-market.md): the catalog, what is
 * added, logins, and the loopback proxy, behind one object the server routes
 * and the MCP session registry use.
 */

export type McpMarketStatus =
  | "not_added"
  | "connected"
  | "refreshable"
  | "needs_login"
  | "unavailable";

export interface McpMarketCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly login: boolean;
  readonly verified: boolean;
  readonly status: McpMarketStatus;
  readonly addedAt: string | null;
  /** AIs left out because the user's own settings already use the name. */
  readonly nameTakenIn: ReadonlyArray<"Claude" | "Codex">;
}

/** What a provider MCP session gets: one entry per added server. */
export interface McpMarketSessionServer {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly authorizationHeader: string;
}

/**
 * Entries not yet verified (catalog `verified`) are offered only when Amu runs
 * with AMU_MCP_MARKET_SHOW_UNVERIFIED=1 — the test copy used to verify them.
 */
const offered = (entry: { readonly verified: boolean }) =>
  entry.verified || process.env.AMU_MCP_MARKET_SHOW_UNVERIFIED === "1";

/** The address the proxy tries first, so login redirect addresses stay the same. */
const PREFERRED_PORT = 47_823;

export class McpMarket {
  readonly store: McpMarketStore;
  readonly oauth: McpMarketOAuth;
  readonly proxy: McpMarketProxy;
  private readonly transport: MarketTransport;

  private constructor(options: {
    stateDir: string;
    secretsDir: string;
    transport: MarketTransport;
    hooks: Omit<ProxyHooks, "onCallback">;
  }) {
    this.transport = options.transport;
    this.store = new McpMarketStore(options.stateDir, options.secretsDir);
    this.oauth = new McpMarketOAuth(
      this.store,
      options.transport,
      () => `${this.proxy.origin}/callback`,
    );
    this.proxy = new McpMarketProxy(this.oauth, options.transport, {
      ...options.hooks,
      onCallback: (params) =>
        this.oauth.callback(params).then(
          (id) =>
            `${findMcpMarketEntry(id)?.name ?? id} につながりました。このタブを閉じて Amu に戻ってください。`,
          (cause) =>
            cause instanceof McpMarketLoginError
              ? `${cause.message}`
              : "ログインを完了できませんでした。Amu からもう一度試してください。",
        ),
    });
  }

  static async start(options: {
    stateDir: string;
    secretsDir: string;
    transport?: MarketTransport;
    port?: number;
    hooks: Omit<ProxyHooks, "onCallback">;
  }): Promise<McpMarket> {
    const market = new McpMarket({ ...options, transport: options.transport ?? httpsTransport });
    await market.proxy.listen(options.port ?? PREFERRED_PORT);
    return market;
  }

  close(): void {
    this.proxy.close();
  }

  cards(): McpMarketCard[] {
    const state = this.store.readState();
    return MCP_MARKET_CATALOG.filter(offered).map((entry) => {
      const server = state.servers[entry.id];
      const secret = server ? this.store.secret(entry.id) : undefined;
      const status: McpMarketStatus = !server
        ? "not_added"
        : this.oauth.isUnavailable(entry.id)
          ? "unavailable"
          : entry.auth.kind === "none"
            ? "connected"
            : !secret || secret.needsLogin
              ? "needs_login"
              : secret.expiresAt !== undefined && secret.expiresAt <= Date.now()
                ? secret.refreshToken
                  ? "refreshable"
                  : "needs_login"
                : "connected";
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        login: entry.auth.kind !== "none",
        verified: entry.verified,
        status,
        addedAt: server?.addedAt ?? null,
        nameTakenIn: [
          ...(userTakenMarketNames("claudeAgent").has(mcpMarketServerName(entry.id))
            ? (["Claude"] as const)
            : []),
          ...(userTakenMarketNames("codex").has(mcpMarketServerName(entry.id))
            ? (["Codex"] as const)
            : []),
        ],
      };
    });
  }

  /**
   * "追加する" / "もう一度ログイン": the address to open in the browser, or
   * null when the server needs no login and is now added.
   */
  async connect(id: string): Promise<string | null> {
    const entry = findMcpMarketEntry(id);
    if (!entry || !offered(entry))
      throw new McpMarketLoginError("このサービスは一覧にありません。");
    if (entry.auth.kind === "oauth-dcr") return await this.oauth.start(id);
    await checkMcpServer(this.transport, entry, undefined).catch(() => {
      throw new McpMarketLoginError(`${entry.name} につながりませんでした。`);
    });
    await this.store.withLock(id, () => {
      if (!this.store.server(id)) this.store.addLocked(id);
    });
    return null;
  }

  /** "外す": local state and secret go at once; upstream is told afterwards. */
  async remove(id: string): Promise<void> {
    const secret = await this.store.withLock(id, () => {
      this.oauth.cancel(id);
      const secret = this.store.secret(id);
      this.store.removeLocked(id);
      this.proxy.abortServer(id);
      return secret;
    });
    if (secret) await this.oauth.revoke(secret, id).catch(() => undefined);
  }

  private readonly sessionServers = new Map<string, ReadonlyArray<McpMarketSessionServer>>();

  /**
   * The servers of a provider MCP session. The set and its credential are
   * fixed the first time a session asks and stay the same until the session
   * is revoked, so adapters that compare their MCP config per turn see no
   * change (a later addition reaches the next session).
   */
  serversForSession(
    session: Omit<ProxyCredential, "servers">,
  ): ReadonlyArray<McpMarketSessionServer> {
    const existing = this.sessionServers.get(session.providerSessionId);
    if (existing) return existing;
    const servers = this.mintForSession(session) ?? [];
    this.sessionServers.set(session.providerSessionId, servers);
    return servers;
  }

  /** For a new provider MCP session: every added server, bound to its current add. */
  mintForSession(
    session: Omit<ProxyCredential, "servers">,
  ): ReadonlyArray<McpMarketSessionServer> | undefined {
    const state = this.store.readState();
    const taken = userTakenMarketNames(session.driver);
    const servers = new Map<string, number>();
    for (const entry of MCP_MARKET_CATALOG) {
      const server = state.servers[entry.id];
      if (server && offered(entry) && !taken.has(mcpMarketServerName(entry.id)))
        servers.set(entry.id, server.generation);
    }
    if (servers.size === 0) return undefined;
    const token = this.proxy.mint({ ...session, servers });
    return [...servers.keys()].map((id) => ({
      id,
      name: mcpMarketServerName(id),
      url: `${this.proxy.origin}/mcp/${id}`,
      authorizationHeader: `Bearer ${token}`,
    }));
  }

  revokeProviderSession(providerSessionId: string): void {
    this.sessionServers.delete(providerSessionId);
    this.proxy.revokeProviderSession(providerSessionId);
  }

  revokeThread(threadId: string): void {
    for (const providerSessionId of this.proxy.revokeThread(threadId))
      this.sessionServers.delete(providerSessionId);
  }

  revokeAll(): void {
    this.sessionServers.clear();
    this.proxy.revokeAll();
  }
}

let activeMarket: McpMarket | undefined;

export const setActiveMcpMarket = (market: McpMarket | undefined) => {
  activeMarket = market;
};
export const activeMcpMarket = () => activeMarket;
