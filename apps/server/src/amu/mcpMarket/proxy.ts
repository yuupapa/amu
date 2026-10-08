// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a loopback-only HTTP server that streams MCP traffic with backpressure; Effect's server cannot pipe a live upstream body this way.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { findMcpMarketEntry, type McpMarketEntry } from "./catalog.ts";
import {
  McpMarketNeedsLogin,
  McpMarketUnavailable,
  type AccessToken,
  type McpMarketOAuth,
  type TokenUse,
} from "./oauth.ts";
import { MARKET_USER_AGENT, type MarketTransport } from "./safeFetch.ts";

/**
 * Amu MCP market: the loopback server Claude and Codex talk to
 * (docs/internals/amu-mcp-market.md, "Proxy"). It listens on 127.0.0.1 only
 * and is not the Amu server port, so Tailscale serving and paired devices
 * never reach it. Two routes:
 *
 * - `/mcp/<id>`: needs one of this server's own per-session credentials;
 *   forwards to the catalog URL with Amu's token for that server.
 * - `/callback`: where the browser returns after a login.
 */

export interface ProxyCredential {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly driver: string;
  /** Fixed when the provider MCP session opened. */
  readonly servers: ReadonlyMap<string, number>;
}

export interface ProxyHooks {
  /**
   * Whether the thread may act outside right now (not plan, not read-only,
   * Claude not in its own plan mode). Unknown counts as no.
   */
  readonly allowsOutsideActions: (credential: ProxyCredential) => Promise<boolean>;
  /** The browser came back from a login; resolves with the page text. */
  readonly onCallback: (params: URLSearchParams) => Promise<string>;
}

const MAX_BODY_BYTES = 4_000_000;
const MAX_STREAMS_PER_SERVER = 8;
const MAX_STREAMS_PER_CREDENTIAL = 4;
/** While restricted, only these may go through; tools/call never. */
const RESTRICTED_METHODS = new Set(["initialize", "ping", "tools/list"]);
const REQUEST_HEADERS = ["content-type", "accept", "mcp-protocol-version", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

const jsonRpcError = (id: unknown, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code: -32001, message },
});

export class McpMarketProxy {
  private readonly credentials = new Map<string, ProxyCredential>();
  /** Upstream session ids per credential and server. */
  private readonly sessions = new Map<string, Set<string>>();
  private readonly openStreams = new Map<string, Set<AbortController>>();
  private server: NodeHttp.Server | undefined;
  private port = 0;

  private readonly oauth: McpMarketOAuth;
  private readonly transport: MarketTransport;
  private readonly hooks: ProxyHooks;

  constructor(oauth: McpMarketOAuth, transport: MarketTransport, hooks: ProxyHooks) {
    this.oauth = oauth;
    this.transport = transport;
    this.hooks = hooks;
  }

  async listen(preferredPort: number): Promise<void> {
    const server = NodeHttp.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      });
    });
    const tryPort = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    await tryPort(preferredPort).catch(() => tryPort(0));
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    this.server = server;
  }

  close(): void {
    this.server?.close();
    for (const streams of this.openStreams.values()) for (const stream of streams) stream.abort();
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** A credential for a provider MCP session; returns the bearer. */
  mint(credential: ProxyCredential): string {
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    this.credentials.set(hash(token), credential);
    return token;
  }

  revokeProviderSession(providerSessionId: string): void {
    for (const [key, credential] of this.credentials)
      if (credential.providerSessionId === providerSessionId) this.drop(key);
  }

  /** Returns the provider sessions whose credentials were dropped. */
  revokeThread(threadId: string): string[] {
    const dropped: string[] = [];
    for (const [key, credential] of this.credentials)
      if (credential.threadId === threadId) {
        dropped.push(credential.providerSessionId);
        this.drop(key);
      }
    return dropped;
  }

  revokeAll(): void {
    for (const key of [...this.credentials.keys()]) this.drop(key);
  }

  private drop(key: string): void {
    this.credentials.delete(key);
    for (const sessionKey of this.sessions.keys())
      if (sessionKey.startsWith(`${key}:`)) this.sessions.delete(sessionKey);
    for (const [streamKey, streams] of this.openStreams)
      if (streamKey.startsWith(`${key}:`)) for (const stream of streams) stream.abort();
  }

  /** Ends every open stream to a server (it was removed). */
  abortServer(serverId: string): void {
    for (const [streamKey, streams] of this.openStreams)
      if (streamKey.endsWith(`:${serverId}`)) for (const stream of streams) stream.abort();
  }

  private streamCount(prefix: (key: string) => boolean): number {
    let count = 0;
    for (const [key, streams] of this.openStreams) if (prefix(key)) count += streams.size;
    return count;
  }

  private async handle(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/callback" && request.method === "GET") {
      const text = await this.hooks.onCallback(url.searchParams);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>Amu</title><body style="font-family:system-ui;padding:3em;line-height:1.7"><p>${text
          .replace(/&/gu, "&amp;")
          .replace(/</gu, "&lt;")}</p></body>`,
      );
      return;
    }
    const match = /^\/mcp\/([a-z0-9-]{1,40})$/u.exec(url.pathname);
    if (!match || !["POST", "GET", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(404).end();
      return;
    }
    const serverId = match[1]!;
    const entry = findMcpMarketEntry(serverId);
    const bearer = /^Bearer ([A-Za-z0-9_-]{20,200})$/u.exec(
      request.headers.authorization ?? "",
    )?.[1];
    const key = bearer ? hash(bearer) : undefined;
    const credential = key ? this.credentials.get(key) : undefined;
    // A credential lives exactly as long as its provider MCP session: the
    // session manager's release path revokes it (McpSessionRegistry).
    if (!entry || !key || !credential) {
      request.resume();
      response
        .writeHead(401, { "Content-Type": "application/json" })
        .end('{"error":"unauthorized"}');
      return;
    }
    // Bound at session open, and still the same add.
    const bound = credential.servers.get(serverId);
    if (bound === undefined || this.oauth.currentGeneration(serverId) !== bound) {
      request.resume();
      this.reply(response, [], false, `${entry.name} は Amu の設定で外されています。`, 404);
      return;
    }
    const body = request.method === "POST" ? await readBody(request, MAX_BODY_BYTES) : undefined;
    if (request.method === "POST" && body === undefined) {
      this.reply(response, [], false, "送る内容が大きすぎます。", 413);
      return;
    }
    const messages = body === undefined ? [] : parseMessages(body);
    if (body !== undefined && messages === undefined) {
      this.reply(response, [], false, "形式が不正です。", 400);
      return;
    }
    const batch = body !== undefined && isBatch(body);
    const answer = (text: string, status = 200) =>
      this.reply(response, messages ?? [], batch, text, status);
    const needsPolicy = (messages ?? []).some(
      (message) => typeof message.method === "string" && !isRestrictedOk(message.method),
    );
    const restrictedText = `この会話のモード（計画モードや読み取り専用）では ${entry.name} のツールは使えません。普通のモードに切り替えてください。`;
    if (needsPolicy && !(await this.hooks.allowsOutsideActions(credential))) {
      answer(restrictedText);
      return;
    }
    const sessionKey = `${key}:${serverId}`;
    const sessionId = request.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      if (typeof sessionId !== "string" || !this.sessions.get(sessionKey)?.has(sessionId)) {
        answer("この MCP セッションは使えません。", 404);
        return;
      }
    }
    if (
      this.streamCount((streamKey) => streamKey.endsWith(`:${serverId}`)) >=
        MAX_STREAMS_PER_SERVER ||
      this.streamCount((streamKey) => streamKey.startsWith(`${key}:`)) >= MAX_STREAMS_PER_CREDENTIAL
    ) {
      answer("同時に開いている接続が多すぎます。少し待ってください。", 429);
      return;
    }
    await this.forward({
      request,
      response,
      entry,
      key,
      credential,
      bound,
      sessionKey,
      body,
      needsPolicy,
      answer,
      restrictedText,
    });
  }

  /**
   * An error for every request in the body (an array for a batch), nothing
   * for notifications; a GET or DELETE gets one error with a null id.
   */
  private reply(
    response: NodeHttp.ServerResponse,
    messages: ReadonlyArray<Message>,
    batch: boolean,
    text: string,
    status = 200,
  ) {
    if (response.headersSent) return response.destroy();
    const requests = messages.filter(
      (message) => typeof message.method === "string" && "id" in message,
    );
    if (messages.length > 0 && requests.length === 0) {
      response.writeHead(202).end();
      return;
    }
    const answers = requests.map((message) => jsonRpcError(message.id, text));
    response
      .writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(
        JSON.stringify(
          messages.length === 0 ? jsonRpcError(null, text) : batch ? answers : answers[0],
        ),
      );
  }

  private async forward(input: {
    request: NodeHttp.IncomingMessage;
    response: NodeHttp.ServerResponse;
    entry: McpMarketEntry;
    key: string;
    credential: ProxyCredential;
    bound: number;
    sessionKey: string;
    body: Buffer | undefined;
    needsPolicy: boolean;
    answer: (text: string, status?: number) => void;
    restrictedText: string;
  }) {
    const { request, response, entry, key, credential, bound, sessionKey, body, answer } = input;
    const headers: Record<string, string> = {
      "User-Agent": MARKET_USER_AGENT,
      "Accept-Encoding": "identity",
    };
    for (const name of REQUEST_HEADERS) {
      const value = request.headers[name];
      if (Array.isArray(value)) return answer("形式が不正です。", 400);
      if (typeof value === "string") headers[name] = value;
    }
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId === "string") headers["mcp-session-id"] = sessionId;
    const abort = new AbortController();
    const streams = this.openStreams.get(sessionKey) ?? new Set();
    streams.add(abort);
    this.openStreams.set(sessionKey, streams);
    const done = () => {
      streams.delete(abort);
      if (streams.size === 0) this.openStreams.delete(sessionKey);
    };
    const closed = new Promise<void>((resolve) =>
      response.once("close", () => {
        abort.abort();
        done();
        resolve();
      }),
    );
    // What the last send used, so a failure is recorded only for it.
    let used: TokenUse | undefined;
    // Checked again right before every send: the add (a remove and re-add),
    // and the thread's mode, may have changed while the body arrived or a
    // refresh ran.
    const send = async (token: AccessToken | undefined) => {
      if (!this.credentials.has(key) || this.oauth.currentGeneration(entry.id) !== bound)
        throw new McpMarketRemoved();
      if (token && token.generation !== bound) throw new McpMarketRemoved();
      if (input.needsPolicy && !(await this.hooks.allowsOutsideActions(credential)))
        throw new McpMarketRestricted();
      used = token
        ? {
            generation: token.generation,
            authVersion: token.authVersion,
            tokenGeneration: token.tokenGeneration,
          }
        : undefined;
      try {
        return await this.transport(entry, {
          method: request.method as "POST" | "GET" | "DELETE",
          url: entry.url,
          headers: { ...headers, ...(token ? { Authorization: `Bearer ${token.token}` } : {}) },
          ...(body === undefined ? {} : { body }),
          signal: abort.signal,
        });
      } catch (cause) {
        throw new McpMarketSendFailed(cause);
      }
    };
    try {
      let token = entry.auth.kind === "none" ? undefined : await this.oauth.accessToken(entry.id);
      let upstream = await send(token);
      // One retry after a plain 401: upstream did not process the request.
      if (upstream.statusCode === 401 && token) {
        upstream.resume();
        token = await this.oauth.afterUnauthorized(entry.id, token);
        upstream = await send(token);
        if (upstream.statusCode === 401) {
          upstream.resume();
          await this.oauth.markNeedsLogin(entry.id, token);
          throw new McpMarketNeedsLogin();
        }
      }
      if (upstream.statusCode === 401) {
        upstream.resume();
        throw new McpMarketNeedsLogin();
      }
      const status = upstream.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstream.resume();
        throw new McpMarketUnavailable();
      }
      this.oauth.noteReachableFor(entry.id, bound, used, status < 500);
      const out: Record<string, string> = {};
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers[name];
        if (typeof value === "string") out[name] = value;
      }
      const upstreamSession = upstream.headers["mcp-session-id"];
      if (typeof upstreamSession === "string" && upstreamSession.length <= 500) {
        const known = this.sessions.get(sessionKey) ?? new Set<string>();
        known.add(upstreamSession);
        this.sessions.set(sessionKey, known);
      }
      if (request.method === "DELETE" && typeof sessionId === "string")
        this.sessions.get(sessionKey)?.delete(sessionId);
      response.writeHead(status, out);
      upstream.pipe(response);
      upstream.once("error", () => response.destroy());
      await closed;
    } catch (cause) {
      if (abort.signal.aborted) return;
      if (cause instanceof McpMarketRemoved)
        return answer(`${entry.name} は Amu の設定で外されています。`, 404);
      if (cause instanceof McpMarketRestricted) return answer(input.restrictedText);
      if (cause instanceof McpMarketNeedsLogin)
        return answer(`Amu の 設定 → MCP で ${entry.name} にもう一度ログインしてください。`);
      // Only a failed send of this request counts against the server; the
      // OAuth side records its own failures with their own checks.
      if (cause instanceof McpMarketSendFailed || cause instanceof McpMarketUnavailable)
        this.oauth.noteReachableFor(entry.id, bound, used, false);
      answer(`${entry.name} に一時的につながりません。少ししてからもう一度試してください。`, 502);
    } finally {
      done();
    }
  }
}

class McpMarketRemoved extends Error {}
class McpMarketRestricted extends Error {}
class McpMarketSendFailed extends Error {
  constructor(cause: unknown) {
    super("send failed", { cause });
  }
}

const isBatch = (body: Buffer) => body.toString("utf8").trimStart().startsWith("[");

const isRestrictedOk = (method: string) =>
  RESTRICTED_METHODS.has(method) || method.startsWith("notifications/");

interface Message {
  readonly id?: unknown;
  readonly method?: unknown;
}

function parseMessages(body: Buffer): Message[] | undefined {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0 || !list.every((item) => item && typeof item === "object"))
      return undefined;
    return list as Message[];
  } catch {
    return undefined;
  }
}

async function readBody(
  request: NodeHttp.IncomingMessage,
  max: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > max) {
      request.destroy();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
