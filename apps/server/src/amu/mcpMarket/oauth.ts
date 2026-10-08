// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - PKCE and state come from node:crypto; login attempts expire by wall clock.
import * as NodeCrypto from "node:crypto";

import { findMcpMarketEntry, isAllowedMarketUrl, type McpMarketEntry } from "./catalog.ts";
import { checkMcpServer, initializeBody, postMcp } from "./mcpClient.ts";
import {
  MARKET_USER_AGENT,
  readMarketResponse,
  type MarketRequest,
  type MarketResponse,
  type MarketTransport,
} from "./safeFetch.ts";
import type { McpMarketSecret, McpMarketStore } from "./store.ts";

/**
 * Amu MCP market: the OAuth 2.1 client (MCP authorization spec) and the
 * tokens it keeps (docs/internals/amu-mcp-market.md, "Login" and "Tokens").
 *
 * Races are settled by numbers, all compared under the server's store lock
 * right before anything is written:
 * - `loginAttempt` (memory) rises on every login start; a login stores its
 *   record and commits only while it is still the latest.
 * - `generation` (state) rises on every add; nothing from an older add is kept.
 * - `authVersion` / `tokenGeneration` (secret) rise on every login / stored
 *   token; a refresh result, or a failure from a request, applies only while
 *   both still equal what it started from.
 */

const ATTEMPT_LIFETIME_MS = 10 * 60_000;
const METADATA_MAX_BYTES = 256_000;
const REFRESH_SKEW_MS = 60_000;
/** One OAuth request, headers and body together. */
const OAUTH_DEADLINE_MS = 20_000;

export class McpMarketLoginError extends Error {}

interface AuthServer {
  readonly issuer: string;
  readonly resource: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly authMethods: ReadonlyArray<string>;
}

interface Attempt {
  readonly state: string;
  readonly attempt: number;
  readonly serverId: string;
  /** The generation the server had at start; undefined when it was not added. */
  readonly generation: number | undefined;
  readonly issuer: string;
  readonly resource: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod: McpMarketSecret["tokenEndpointAuthMethod"];
  readonly redirectUri: string;
  readonly verifier: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly createdAt: number;
}

export interface AccessToken {
  readonly token: string;
  readonly generation: number;
  readonly authVersion: number;
  readonly tokenGeneration: number;
}

/** What a request sent; failures are applied only while it is still current. */
export type TokenUse = Omit<AccessToken, "token">;

const base64Url = (bytes: Buffer) => bytes.toString("base64url");
const randomToken = () => base64Url(NodeCrypto.randomBytes(32));

const timingSafeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

const json = (response: MarketResponse): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(response.body.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export class McpMarketOAuth {
  private readonly attempts = new Map<string, Attempt>();
  private readonly latestAttempt = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<AccessToken>>();
  /** Servers that were briefly unreachable, with the add it was seen for (memory, for the card). */
  private readonly unreachable = new Map<string, number>();

  private readonly store: McpMarketStore;
  private readonly transport: MarketTransport;
  /** The loopback callback address, e.g. http://127.0.0.1:47823/callback. */
  private readonly redirectUri: () => string;
  private readonly now: () => number;

  constructor(
    store: McpMarketStore,
    transport: MarketTransport,
    redirectUri: () => string,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.transport = transport;
    this.redirectUri = redirectUri;
    this.now = now;
  }

  /** One OAuth exchange, headers and body together, within OAUTH_DEADLINE_MS. */
  private async exchange(entry: McpMarketEntry, request: Omit<MarketRequest, "signal">) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), OAUTH_DEADLINE_MS);
    try {
      return await readMarketResponse(
        await this.transport(entry, { ...request, signal: deadline.signal }),
        METADATA_MAX_BYTES,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(entry: McpMarketEntry, url: string) {
    if (!isAllowedMarketUrl(entry, url))
      throw new McpMarketLoginError("ログインの手順に、許可していない接続先が含まれていました。");
    const response = await this.exchange(entry, {
      method: "GET",
      url,
      headers: { Accept: "application/json", "User-Agent": MARKET_USER_AGENT },
    });
    return response.status === 200 ? json(response) : undefined;
  }

  private async postForm(
    entry: McpMarketEntry,
    url: string,
    form: Record<string, string>,
    basic?: string,
  ) {
    if (!isAllowedMarketUrl(entry, url))
      throw new McpMarketLoginError("ログインの手順に、許可していない接続先が含まれていました。");
    return await this.exchange(entry, {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": MARKET_USER_AGENT,
        ...(basic ? { Authorization: `Basic ${basic}` } : {}),
      },
      body: new URLSearchParams(form).toString(),
    });
  }

  /** Protected-resource metadata → authorization-server metadata. */
  private async discover(entry: McpMarketEntry): Promise<AuthServer> {
    const probe = await postMcp(this.transport, entry, initializeBody(0), {}, 0);
    const challenge = String(probe.headers["www-authenticate"] ?? "");
    const resourceMetadataUrl = /resource_metadata="([^"]+)"/u.exec(challenge)?.[1];
    const resourceUrl = new URL(entry.url);
    const candidates = [
      ...(resourceMetadataUrl ? [resourceMetadataUrl] : []),
      `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname.replace(/\/$/u, "")}`,
      `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
    ];
    let resourceMetadata: Record<string, unknown> | undefined;
    for (const url of candidates) {
      resourceMetadata = await this.getJson(entry, url).catch((cause) => {
        if (cause instanceof McpMarketLoginError) throw cause;
        return undefined;
      });
      if (resourceMetadata) break;
    }
    const issuer = Array.isArray(resourceMetadata?.authorization_servers)
      ? text(resourceMetadata.authorization_servers[0])
      : undefined;
    if (!issuer)
      throw new McpMarketLoginError("このサービスのログイン方法が見つかりませんでした。");
    const issuerUrl = new URL(issuer);
    const path = issuerUrl.pathname.replace(/\/$/u, "");
    let metadata: Record<string, unknown> | undefined;
    for (const url of [
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuerUrl.origin}/.well-known/openid-configuration${path}`,
      `${issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`,
    ]) {
      metadata = await this.getJson(entry, url).catch((cause) => {
        if (cause instanceof McpMarketLoginError) throw cause;
        return undefined;
      });
      if (metadata) break;
    }
    const authorizationEndpoint = text(metadata?.authorization_endpoint);
    const tokenEndpoint = text(metadata?.token_endpoint);
    const registrationEndpoint = text(metadata?.registration_endpoint);
    const revocationEndpoint = text(metadata?.revocation_endpoint);
    const challenges = Array.isArray(metadata?.code_challenge_methods_supported)
      ? metadata.code_challenge_methods_supported
      : [];
    if (
      !authorizationEndpoint ||
      !tokenEndpoint ||
      !registrationEndpoint ||
      !challenges.includes("S256") ||
      ![
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint,
        ...(revocationEndpoint ? [revocationEndpoint] : []),
      ].every((url) => isAllowedMarketUrl(entry, url))
    )
      throw new McpMarketLoginError("このサービスのログイン方法に Amu は対応していません。");
    return {
      issuer,
      resource: text(resourceMetadata?.resource) ?? entry.url,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
      authMethods: Array.isArray(metadata?.token_endpoint_auth_methods_supported)
        ? metadata.token_endpoint_auth_methods_supported.filter(
            (m): m is string => typeof m === "string",
          )
        : ["client_secret_basic"],
    };
  }

  private async client(entry: McpMarketEntry, server: AuthServer, redirectUri: string) {
    const saved = this.store.registration(server.issuer, redirectUri);
    if (saved) return saved;
    const method: McpMarketSecret["tokenEndpointAuthMethod"] = server.authMethods.includes("none")
      ? "none"
      : server.authMethods.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic";
    if (!isAllowedMarketUrl(entry, server.registrationEndpoint))
      throw new McpMarketLoginError("ログインの手順に、許可していない接続先が含まれていました。");
    const response = await this.exchange(entry, {
      method: "POST",
      url: server.registrationEndpoint,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": MARKET_USER_AGENT,
      },
      body: JSON.stringify({
        client_name: "Amu",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: method,
      }),
    });
    const body = json(response);
    const clientId = text(body?.client_id);
    if ((response.status !== 200 && response.status !== 201) || !clientId)
      throw new McpMarketLoginError("このサービスに Amu を登録できませんでした。");
    const clientSecret = text(body?.client_secret);
    const registration = {
      issuer: server.issuer,
      redirectUri,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      tokenEndpointAuthMethod: clientSecret ? method : ("none" as const),
    };
    this.store.saveRegistration(registration);
    return registration;
  }

  /**
   * Starts a login and returns the address to open in the browser. A newer
   * start makes every older one void.
   */
  async start(serverId: string): Promise<string> {
    const entry = findMcpMarketEntry(serverId);
    if (!entry || entry.auth.kind !== "oauth-dcr")
      throw new McpMarketLoginError("このサービスはログインを使いません。");
    const attemptNumber = (this.latestAttempt.get(serverId) ?? 0) + 1;
    this.latestAttempt.set(serverId, attemptNumber);
    for (const [state, attempt] of this.attempts)
      if (attempt.serverId === serverId) this.attempts.delete(state);
    const generation = this.store.server(serverId)?.generation;
    const server = await this.discover(entry);
    const redirectUri = this.redirectUri();
    const client = await this.client(entry, server, redirectUri);
    // An older start that finishes its preparation later stores nothing.
    if (this.latestAttempt.get(serverId) !== attemptNumber)
      throw new McpMarketLoginError("新しいログインが始まったため、この手続きは取りやめました。");
    const state = randomToken();
    const verifier = randomToken();
    const challenge = base64Url(NodeCrypto.createHash("sha256").update(verifier).digest());
    this.attempts.set(state, {
      state,
      attempt: attemptNumber,
      serverId,
      generation,
      issuer: server.issuer,
      resource: server.resource,
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
      redirectUri,
      verifier,
      tokenEndpoint: server.tokenEndpoint,
      ...(server.revocationEndpoint ? { revocationEndpoint: server.revocationEndpoint } : {}),
      createdAt: this.now(),
    });
    const url = new URL(server.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", server.resource);
    if (entry.auth.scopes.length > 0) url.searchParams.set("scope", entry.auth.scopes.join(" "));
    return url.toString();
  }

  /** Stops a pending login (removal, or the user closing the card). */
  cancel(serverId: string): void {
    this.latestAttempt.set(serverId, (this.latestAttempt.get(serverId) ?? 0) + 1);
    for (const [state, attempt] of this.attempts)
      if (attempt.serverId === serverId) this.attempts.delete(state);
  }

  private clientAuth(
    secret: Pick<McpMarketSecret, "clientId" | "clientSecret" | "tokenEndpointAuthMethod">,
    form: Record<string, string>,
  ): { form: Record<string, string>; basic?: string } {
    if (secret.tokenEndpointAuthMethod === "client_secret_basic" && secret.clientSecret)
      return {
        form,
        basic: Buffer.from(
          `${encodeURIComponent(secret.clientId)}:${encodeURIComponent(secret.clientSecret)}`,
        ).toString("base64"),
      };
    return {
      form: {
        ...form,
        client_id: secret.clientId,
        ...(secret.tokenEndpointAuthMethod === "client_secret_post" && secret.clientSecret
          ? { client_secret: secret.clientSecret }
          : {}),
      },
    };
  }

  /**
   * The browser came back. Resolves with the server id once the login is
   * stored and checked; rejects with a message for the callback page.
   */
  async callback(params: URLSearchParams): Promise<string> {
    const state = params.get("state") ?? "";
    let found: Attempt | undefined;
    for (const [key, attempt] of this.attempts) if (timingSafeEqual(key, state)) found = attempt;
    // An unknown state touches nothing; a known one is used up here, once.
    if (!found)
      throw new McpMarketLoginError(
        "このログインは見つかりません。Amu からもう一度始めてください。",
      );
    this.attempts.delete(found.state);
    const attempt = found;
    if (this.now() - attempt.createdAt > ATTEMPT_LIFETIME_MS)
      throw new McpMarketLoginError("ログインの時間切れです。Amu からもう一度始めてください。");
    const code = params.get("code");
    if (!code) throw new McpMarketLoginError("ログインが許可されませんでした。");
    const entry = findMcpMarketEntry(attempt.serverId)!;
    const { form, basic } = this.clientAuth(attempt, {
      grant_type: "authorization_code",
      code,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.verifier,
      resource: attempt.resource,
    });
    const response = await this.postForm(entry, attempt.tokenEndpoint, form, basic);
    const token = json(response);
    const accessToken = text(token?.access_token);
    if (response.status !== 200 || !accessToken)
      throw new McpMarketLoginError("ログインを完了できませんでした。もう一度試してください。");
    const refreshToken = text(token?.refresh_token);
    const expiresIn = typeof token?.expires_in === "number" ? token.expires_in : undefined;
    // Before keeping it, the token must open the server and list its tools.
    await checkMcpServer(this.transport, entry, accessToken).catch(() => {
      throw new McpMarketLoginError(
        "ログインはできましたが、このサービスのツールを読み込めませんでした。",
      );
    });
    await this.store.withLock(attempt.serverId, () => {
      if (this.latestAttempt.get(attempt.serverId) !== attempt.attempt)
        throw new McpMarketLoginError("新しいログインが始まったため、この手続きは取りやめました。");
      const current = this.store.server(attempt.serverId);
      if (attempt.generation !== undefined && current?.generation !== attempt.generation)
        throw new McpMarketLoginError(
          "このサービスは外されました。Amu からもう一度追加してください。",
        );
      const previous = current ? this.store.secret(attempt.serverId) : undefined;
      const server = current ?? this.store.addLocked(attempt.serverId);
      this.store.writeSecretLocked(attempt.serverId, {
        generation: server.generation,
        clientId: attempt.clientId,
        ...(attempt.clientSecret ? { clientSecret: attempt.clientSecret } : {}),
        tokenEndpointAuthMethod: attempt.tokenEndpointAuthMethod,
        redirectUri: attempt.redirectUri,
        issuer: attempt.issuer,
        resource: attempt.resource,
        tokenEndpoint: attempt.tokenEndpoint,
        ...(attempt.revocationEndpoint ? { revocationEndpoint: attempt.revocationEndpoint } : {}),
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresIn ? { expiresAt: this.now() + expiresIn * 1000 } : {}),
        tokenGeneration: (previous?.tokenGeneration ?? 0) + 1,
        authVersion: (previous?.authVersion ?? 0) + 1,
      });
      this.unreachable.delete(attempt.serverId);
    });
    return attempt.serverId;
  }

  /** Whether the card should say 一時的に使えません. */
  isUnavailable(serverId: string): boolean {
    const generation = this.unreachable.get(serverId);
    return generation !== undefined && generation === this.currentGeneration(serverId);
  }

  /** A request to the server got through (or not); only for the add it was sent for. */
  noteReachable(serverId: string, generation: number, reachable: boolean): void {
    if (this.currentGeneration(serverId) !== generation) return;
    if (reachable) this.unreachable.delete(serverId);
    else this.unreachable.set(serverId, generation);
  }

  /**
   * The same, for a request that used `used`: recorded only while that token
   * is still the stored one, so a late failure from before a login is ignored.
   */
  noteReachableFor(
    serverId: string,
    generation: number,
    used: TokenUse | undefined,
    reachable: boolean,
  ): void {
    if (used !== undefined) {
      const secret = this.store.secret(serverId);
      if (
        used.generation !== generation ||
        secret?.authVersion !== used.authVersion ||
        secret.tokenGeneration !== used.tokenGeneration
      )
        return;
    }
    this.noteReachable(serverId, generation, reachable);
  }

  /** The server's generation while it is added. */
  currentGeneration(serverId: string): number | undefined {
    return this.store.server(serverId)?.generation;
  }

  /** The token to send now, refreshed first when it has run out. */
  async accessToken(serverId: string): Promise<AccessToken> {
    const server = this.store.server(serverId);
    const secret = this.store.secret(serverId);
    if (!server || !secret || secret.needsLogin) throw new McpMarketNeedsLogin();
    const current: AccessToken = {
      token: secret.accessToken,
      generation: server.generation,
      authVersion: secret.authVersion,
      tokenGeneration: secret.tokenGeneration,
    };
    if (secret.expiresAt === undefined || secret.expiresAt - REFRESH_SKEW_MS > this.now())
      return current;
    if (!secret.refreshToken) throw new McpMarketNeedsLogin();
    return await this.refresh(serverId, current);
  }

  /**
   * After an upstream 401 for a request that used `used`: a newer token is
   * returned as it is; otherwise one refresh, shared by every caller.
   */
  async afterUnauthorized(serverId: string, used: TokenUse): Promise<AccessToken> {
    const server = this.store.server(serverId);
    const secret = this.store.secret(serverId);
    if (!server || !secret) throw new McpMarketNeedsLogin();
    if (
      server.generation !== used.generation ||
      secret.authVersion !== used.authVersion ||
      secret.tokenGeneration !== used.tokenGeneration
    ) {
      if (secret.needsLogin) throw new McpMarketNeedsLogin();
      return {
        token: secret.accessToken,
        generation: server.generation,
        authVersion: secret.authVersion,
        tokenGeneration: secret.tokenGeneration,
      };
    }
    if (!secret.refreshToken) {
      await this.markNeedsLogin(serverId, used);
      throw new McpMarketNeedsLogin();
    }
    return await this.refresh(serverId, { ...used, token: secret.accessToken });
  }

  /** The server refused a token that was still current: log in again. */
  async markNeedsLogin(serverId: string, used: TokenUse): Promise<void> {
    await this.store.withLock(serverId, () => {
      const server = this.store.server(serverId);
      const secret = this.store.secret(serverId);
      if (
        server?.generation === used.generation &&
        secret?.authVersion === used.authVersion &&
        secret.tokenGeneration === used.tokenGeneration
      )
        this.store.writeSecretLocked(serverId, { ...secret, needsLogin: true });
    });
  }

  private refresh(serverId: string, from: AccessToken): Promise<AccessToken> {
    const running = this.refreshing.get(serverId);
    if (running) return running;
    const work = this.refreshOnce(serverId, from).finally(() => {
      if (this.refreshing.get(serverId) === work) this.refreshing.delete(serverId);
    });
    this.refreshing.set(serverId, work);
    return work;
  }

  private async refreshOnce(serverId: string, from: AccessToken): Promise<AccessToken> {
    const entry = findMcpMarketEntry(serverId)!;
    const secret = this.store.secret(serverId);
    if (!secret?.refreshToken) throw new McpMarketNeedsLogin();
    const { form, basic } = this.clientAuth(secret, {
      grant_type: "refresh_token",
      refresh_token: secret.refreshToken,
      resource: secret.resource,
    });
    let response: MarketResponse;
    try {
      response = await this.postForm(entry, secret.tokenEndpoint, form, basic);
    } catch (cause) {
      // Only while nothing newer was stored: a login meanwhile is not marked.
      await this.store.withLock(serverId, () => {
        const now = this.store.secret(serverId);
        if (
          this.currentGeneration(serverId) === from.generation &&
          now?.authVersion === from.authVersion &&
          now.tokenGeneration === from.tokenGeneration
        )
          this.noteReachable(serverId, from.generation, false);
      });
      throw cause;
    }
    const body = json(response);
    const accessToken = text(body?.access_token);
    const rejected = response.status === 400 || response.status === 401;
    return await this.store.withLock(serverId, () => {
      const server = this.store.server(serverId);
      const now = this.store.secret(serverId);
      const stillCurrent =
        server?.generation === from.generation &&
        now?.authVersion === from.authVersion &&
        now.tokenGeneration === from.tokenGeneration;
      if (!server || !now) throw new McpMarketNeedsLogin();
      if (!stillCurrent) {
        // A login or another refresh got there first; use what it stored.
        if (now.needsLogin) throw new McpMarketNeedsLogin();
        return {
          token: now.accessToken,
          generation: server.generation,
          authVersion: now.authVersion,
          tokenGeneration: now.tokenGeneration,
        };
      }
      if (response.status !== 200 || !accessToken) {
        if (rejected) {
          this.store.writeSecretLocked(serverId, { ...now, needsLogin: true });
          throw new McpMarketNeedsLogin();
        }
        this.noteReachable(serverId, from.generation, false);
        throw new McpMarketUnavailable();
      }
      const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : undefined;
      const refreshToken = text(body?.refresh_token) ?? now.refreshToken;
      const { expiresAt: _old, ...rest } = now;
      const next: McpMarketSecret = {
        ...rest,
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresIn ? { expiresAt: this.now() + expiresIn * 1000 } : {}),
        tokenGeneration: now.tokenGeneration + 1,
      };
      this.store.writeSecretLocked(serverId, next);
      this.noteReachable(serverId, from.generation, true);
      return {
        token: accessToken,
        generation: server.generation,
        authVersion: next.authVersion,
        tokenGeneration: next.tokenGeneration,
      };
    });
  }

  /** Best effort: tells the server the tokens are no longer used. */
  async revoke(secret: McpMarketSecret, serverId: string): Promise<void> {
    if (!secret.revocationEndpoint) return;
    const entry = findMcpMarketEntry(serverId);
    if (!entry) return;
    for (const [token, hint] of [
      [secret.refreshToken, "refresh_token"],
      [secret.accessToken, "access_token"],
    ] as const) {
      if (!token) continue;
      const { form, basic } = this.clientAuth(secret, { token, token_type_hint: hint });
      await this.postForm(entry, secret.revocationEndpoint, form, basic).catch(() => undefined);
    }
  }
}

export class McpMarketNeedsLogin extends Error {
  constructor() {
    super("needs login");
  }
}
export class McpMarketUnavailable extends Error {
  constructor() {
    super("temporarily unavailable");
  }
}
