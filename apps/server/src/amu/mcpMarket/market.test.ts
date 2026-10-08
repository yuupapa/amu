// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off - a local fake OAuth and MCP server, temporary folders, and short waits.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

// The fake servers stand in for catalog entries that are not verified yet.
process.env.AMU_MCP_MARKET_SHOW_UNVERIFIED = "1";

import { findMcpMarketEntry, isAllowedMarketUrl } from "./catalog.ts";
import { McpMarket } from "./market.ts";
import type { ProxyCredential } from "./proxy.ts";
import type { MarketTransport } from "./safeFetch.ts";

/**
 * A fake Linear: its OAuth server and MCP server answer on one local port.
 * The test transport sends every request for https://mcp.linear.app there,
 * after the same allowlist check the real transport makes.
 */
interface Fake {
  server: NodeHttp.Server;
  port: number;
  codes: Map<string, { challenge: string; redirectUri: string; clientId: string }>;
  accessTokens: Set<string>;
  refreshTokens: Set<string>;
  seen: Array<{ method: string; path: string; auth?: string; body?: string; session?: string }>;
  refreshes: number;
  /** When set, the next MCP request answers 401 once even with a valid token. */
  rejectNext: boolean;
  /** Answer initialize and tools/list as an event stream that stays open. */
  holdStreams: boolean;
  /** The Mcp-Session-Id initialize hands out. */
  sessionId: string;
  /** Called when a refresh request arrives, before it is answered. */
  onRefresh?: () => void;
}

const read = (request: NodeHttp.IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

async function startFake(): Promise<Fake> {
  const fake: Fake = {
    server: undefined as unknown as NodeHttp.Server,
    port: 0,
    codes: new Map(),
    accessTokens: new Set(),
    refreshTokens: new Set(),
    seen: [],
    refreshes: 0,
    rejectNext: false,
    holdStreams: false,
    sessionId: "up-session-1",
  };
  const issue = () => {
    const access = `at-${NodeCrypto.randomUUID()}`;
    const refresh = `rt-${NodeCrypto.randomUUID()}`;
    fake.accessTokens.add(access);
    fake.refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" };
  };
  fake.server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://x");
      const body = await read(request);
      fake.seen.push({
        method: request.method ?? "",
        path: url.pathname,
        ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
        ...(body ? { body } : {}),
        ...(typeof request.headers["mcp-session-id"] === "string"
          ? { session: request.headers["mcp-session-id"] }
          : {}),
      });
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "Content-Type": "application/json", ...headers });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return send(200, {
          resource: "https://mcp.linear.app/mcp",
          authorization_servers: ["https://mcp.linear.app"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return send(200, {
          issuer: "https://mcp.linear.app",
          authorization_endpoint: "https://mcp.linear.app/authorize",
          token_endpoint: "https://mcp.linear.app/token",
          registration_endpoint: "https://mcp.linear.app/register",
          revocation_endpoint: "https://mcp.linear.app/token",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/register") return send(201, { client_id: `client-${fake.port}` });
      if (url.pathname === "/token") {
        const form = new URLSearchParams(body);
        if (form.get("token")) return send(200, {});
        if (form.get("grant_type") === "authorization_code") {
          const code = fake.codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
          if (
            !code ||
            code.challenge !== challenge ||
            code.redirectUri !== form.get("redirect_uri")
          )
            return send(400, { error: "invalid_grant" });
          fake.codes.delete(form.get("code")!);
          return send(200, issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          fake.refreshes += 1;
          fake.onRefresh?.();
          const old = form.get("refresh_token") ?? "";
          if (!fake.refreshTokens.delete(old)) return send(400, { error: "invalid_grant" });
          return send(200, issue());
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/mcp") {
        const token = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
        const open = request.headers["x-fake-origin"] === "https://mcp.context7.com";
        if (
          !open &&
          (!token ||
            !fake.accessTokens.has(token) ||
            (fake.rejectNext && request.method === "POST"))
        ) {
          fake.rejectNext = false;
          return send(
            401,
            { error: "unauthorized" },
            {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"',
            },
          );
        }
        if (request.method === "DELETE") return send(200, {});
        const message = JSON.parse(body) as { id?: number; method: string };
        if (
          fake.holdStreams &&
          (message.method === "initialize" || message.method === "tools/list")
        ) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            ...(message.method === "initialize" ? { "Mcp-Session-Id": "up-session-1" } : {}),
          });
          const result =
            message.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } }
              : { tools: [{ name: "list_issues" }] };
          response.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
          );
          return; // never ended
        }
        if (message.method === "initialize")
          return send(
            200,
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "fake" },
              },
            },
            { "Mcp-Session-Id": fake.sessionId },
          );
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/list")
          return send(200, {
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "list_issues" }] },
          });
        if (message.method === "tools/call")
          return send(200, {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "ok" }] },
          });
      }
      send(404, {});
    })();
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.port = (fake.server.address() as { port: number }).port;
  return fake;
}

/** Stands in for the name lookup: runs before `beforeSend`, like DNS in the real transport. */
let lookupDelay: (() => Promise<void>) | undefined;

const fakeTransport =
  (fake: Fake): MarketTransport =>
  async (entry, request) => {
    if (!isAllowedMarketUrl(entry, request.url)) throw new Error("not allowed");
    const url = new URL(request.url);
    await lookupDelay?.();
    await request.beforeSend?.();
    return await new Promise((resolve, reject) => {
      const outgoing = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: fake.port,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: { ...request.headers, "x-fake-origin": url.origin },
          ...(request.signal ? { signal: request.signal } : {}),
        },
        resolve,
      );
      outgoing.on("error", reject);
      outgoing.end(request.body);
    });
  };

let fake: Fake;
let market: McpMarket;
let folder: string;
let allowed = true;

beforeEach(async () => {
  lookupDelay = undefined;
  fake = await startFake();
  folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "amu-mcp-market-"));
  allowed = true;
  market = await McpMarket.start({
    stateDir: NodePath.join(folder, "state"),
    secretsDir: NodePath.join(folder, "secrets"),
    transport: fakeTransport(fake),
    port: 0,
    hooks: {
      allowsOutsideActions: async () => allowed,
    },
  });
});

afterEach(() => {
  market.close();
  fake.server.close();
  NodeFS.rmSync(folder, { recursive: true, force: true });
});

/** Plays the browser: approve at the fake authorize page, then come back. */
async function approve(authorizationUrl: string): Promise<string> {
  const url = new URL(authorizationUrl);
  const code = `code-${NodeCrypto.randomUUID()}`;
  fake.codes.set(code, {
    challenge: url.searchParams.get("code_challenge")!,
    redirectUri: url.searchParams.get("redirect_uri")!,
    clientId: url.searchParams.get("client_id")!,
  });
  const back = new URL(url.searchParams.get("redirect_uri")!);
  back.searchParams.set("state", url.searchParams.get("state")!);
  back.searchParams.set("code", code);
  return (await fetch(back)).text();
}

const session = (id = "session-1"): Omit<ProxyCredential, "servers"> => ({
  environmentId: "env",
  threadId: `thread-${id}`,
  providerSessionId: id,
  driver: "claudeAgent",
});

async function call(url: string, authorization: string, message: unknown, sessionId?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  return {
    status: response.status,
    session: response.headers.get("mcp-session-id"),
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function connectLinear() {
  const authorizationUrl = await market.connect("linear");
  expect(authorizationUrl).toBeTruthy();
  const page = await approve(authorizationUrl!);
  expect(page).toContain("つながりました");
  const [server] = market.mintForSession(session()) ?? [];
  return server!;
}

describe("MCP market login", () => {
  it("logs in with PKCE, checks the tools, and shows the server connected", async () => {
    const authorizationUrl = (await market.connect("linear"))!;
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://mcp.linear.app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://mcp.linear.app/mcp");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(market.cards().find((card) => card.id === "linear")?.status).toBe("not_added");
    expect(await approve(authorizationUrl)).toContain("つながりました");
    expect(market.cards().find((card) => card.id === "linear")?.status).toBe("connected");
    // The token went through initialize and tools/list before it was kept.
    expect(fake.seen.some((request) => request.body?.includes('"tools/list"'))).toBe(true);
    const secretFile = NodePath.join(folder, "secrets", "amu-mcp-market-linear.json");
    expect(NodeFS.statSync(secretFile).mode & 0o777).toBe(0o600);
  });

  it("refuses an unknown state and a callback from an older start", async () => {
    const page = await (await fetch(`${market.proxy.origin}/callback?state=nope&code=x`)).text();
    expect(page).toContain("見つかりません");
    const first = (await market.connect("linear"))!;
    const second = (await market.connect("linear"))!;
    expect(await approve(first)).toContain("見つかりません");
    expect(await approve(second)).toContain("つながりました");
  });

  it("does not keep a login that finishes after the server was removed", async () => {
    const authorizationUrl = (await market.connect("linear"))!;
    await market.remove("linear");
    expect(await approve(authorizationUrl)).not.toContain("つながりました");
    expect(market.store.server("linear")).toBeUndefined();
  });
});

describe("MCP market proxy", () => {
  it("forwards with Amu's token, never the AI's credential", async () => {
    const server = await connectLinear();
    const init = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(init.status).toBe(200);
    expect(init.session).toBe("up-session-1");
    const listed = await call(
      server.url,
      server.authorizationHeader,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      "up-session-1",
    );
    expect((listed.body.result as { tools: unknown[] }).tools).toHaveLength(1);
    const upstream = fake.seen.filter((request) => request.path === "/mcp").at(-1)!;
    expect(upstream.auth).toMatch(/^Bearer at-/u);
    expect(upstream.auth).not.toBe(server.authorizationHeader);
  });

  it("refuses a missing or wrong credential, and a session id it did not see", async () => {
    const server = await connectLinear();
    expect(
      (
        await call(server.url, "Bearer wrongwrongwrongwrongwrong", {
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
        })
      ).status,
    ).toBe(401);
    const stray = await call(
      server.url,
      server.authorizationHeader,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "someone-elses-session",
    );
    expect(stray.status).toBe(404);
  });

  it("refuses tools/call while the thread may not act outside, but still lists tools", async () => {
    const server = await connectLinear();
    allowed = false;
    const listed = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(listed.body.result).toBeDefined();
    const called = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_issues" },
    });
    expect((called.body.error as { message: string }).message).toContain("計画モード");
    expect(fake.seen.some((request) => request.body?.includes('"tools/call"'))).toBe(false);
    allowed = true;
    const again = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_issues" },
    });
    expect(again.body.result).toBeDefined();
  });

  it("refreshes once after a 401 and retries with the new token", async () => {
    const server = await connectLinear();
    fake.rejectNext = true;
    const listed = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(listed.body.result).toBeDefined();
    expect(fake.refreshes).toBe(1);
  });

  it("shares one refresh between requests that hit 401 together", async () => {
    const server = await connectLinear();
    const old = [...fake.accessTokens];
    fake.accessTokens.clear();
    const results = await Promise.all(
      [1, 2, 3].map((id) =>
        call(server.url, server.authorizationHeader, { jsonrpc: "2.0", id, method: "tools/list" }),
      ),
    );
    expect(results.every((result) => result.body.result !== undefined)).toBe(true);
    expect(fake.refreshes).toBe(1);
    expect(old.length).toBeGreaterThan(0);
  });

  it("asks for a new login when the refresh is refused, and tells the AI so", async () => {
    const server = await connectLinear();
    fake.accessTokens.clear();
    fake.refreshTokens.clear();
    const listed = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect((listed.body.error as { message: string }).message).toContain("もう一度ログイン");
    expect(market.cards().find((card) => card.id === "linear")?.status).toBe("needs_login");
  });

  it("keeps refusing a session from before a remove after the server is added again", async () => {
    const server = await connectLinear();
    await market.remove("linear");
    expect(market.store.server("linear")).toBeUndefined();
    const removed = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(removed.status).toBe(404);
    const again = (await market.connect("linear"))!;
    await approve(again);
    const stale = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(stale.status).toBe(404);
    const [fresh] = market.mintForSession(session("session-2")) ?? [];
    expect(
      (
        await call(fresh!.url, fresh!.authorizationHeader, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        })
      ).body.result,
    ).toBeDefined();
  });

  it("drops a provider session's credential when it is revoked", async () => {
    const server = await connectLinear();
    market.revokeProviderSession("session-1");
    expect(
      (
        await call(server.url, server.authorizationHeader, {
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
        })
      ).status,
    ).toBe(401);
  });
});

describe("MCP market catalog", () => {
  it("allows only HTTPS on an entry's own origins", () => {
    const linear = findMcpMarketEntry("linear")!;
    expect(isAllowedMarketUrl(linear, "https://mcp.linear.app/token")).toBe(true);
    expect(isAllowedMarketUrl(linear, "http://mcp.linear.app/token")).toBe(false);
    expect(isAllowedMarketUrl(linear, "https://evil.example/token")).toBe(false);
    expect(isAllowedMarketUrl(linear, "https://user:pw@mcp.linear.app/")).toBe(false);
    expect(isAllowedMarketUrl(linear, "https://127.0.0.1/")).toBe(false);
  });
});

describe("MCP market fixes from review round 1", () => {
  it("answers every request of a refused batch, and nothing for notifications", async () => {
    const server = await connectLinear();
    allowed = false;
    const response = await fetch(server.url, {
      method: "POST",
      headers: { Authorization: server.authorizationHeader, "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_issues" } },
        { jsonrpc: "2.0", method: "notifications/progress" },
      ]),
    });
    const answers = (await response.json()) as Array<{ id: number; error?: unknown }>;
    expect(answers.map((answer) => answer.id)).toEqual([1, 2]);
    expect(answers.every((answer) => answer.error !== undefined)).toBe(true);
  });

  it("does not send a body that finished after the server was removed and added again", async () => {
    const server = await connectLinear();
    const url = new URL(server.url);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "list_issues" },
    });
    const answer = new Promise<{ status: number; text: string }>((resolve) => {
      const request = NodeHttp.request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            Authorization: server.authorizationHeader,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
        },
      );
      request.write(body.slice(0, 10));
      void (async () => {
        await new Promise((r) => setTimeout(r, 50));
        await market.remove("linear");
        await approve((await market.connect("linear"))!);
        request.end(body.slice(10));
      })();
    });
    const result = await answer;
    expect(result.status).toBe(404);
    expect(fake.seen.some((request) => request.body?.includes('"id":9'))).toBe(false);
  });

  it("finishes the login check when the server answers on a stream it keeps open", async () => {
    fake.holdStreams = true;
    const authorizationUrl = (await market.connect("linear"))!;
    expect(await approve(authorizationUrl)).toContain("つながりました");
  }, 15_000);

  it("stops a tool call whose thread entered plan mode while the token was refreshed", async () => {
    const server = await connectLinear();
    fake.accessTokens.clear();
    fake.onRefresh = () => {
      allowed = false;
    };
    const called = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_issues" },
    });
    expect((called.body.error as { message: string }).message).toContain("計画モード");
    // Only the first attempt went out (refused with 401); the retry did not.
    expect(fake.seen.filter((request) => request.body?.includes('"tools/call"'))).toHaveLength(1);
  });

  it("answers every request of a batch when a login is needed", async () => {
    const server = await connectLinear();
    fake.accessTokens.clear();
    fake.refreshTokens.clear();
    const response = await fetch(server.url, {
      method: "POST",
      headers: { Authorization: server.authorizationHeader, "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 10, method: "tools/list" },
        { jsonrpc: "2.0", id: 20, method: "tools/list" },
      ]),
    });
    const answers = (await response.json()) as Array<{ id: number }>;
    expect(answers.map((answer) => answer.id)).toEqual([10, 20]);
  });

  it("names servers with this installation's own suffix", async () => {
    const server = await connectLinear();
    expect(server.name).toMatch(/^amu-mcp-linear-[a-f0-9]{6}$/u);
    const [again] = market.mintForSession(session("session-3")) ?? [];
    expect(again!.name).toBe(server.name);
  });

  it("checks the mode again after the name lookup, right before sending", async () => {
    const server = await connectLinear();
    lookupDelay = async () => {
      allowed = false;
    };
    const called = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "list_issues" },
    });
    expect((called.body.error as { message: string }).message).toContain("計画モード");
    expect(fake.seen.some((request) => request.body?.includes('"tools/call"'))).toBe(false);
  });

  it("answers the AI when Amu stops a request before the reply", async () => {
    const server = await connectLinear();
    let release: () => void = () => undefined;
    lookupDelay = () => new Promise<void>((resolve) => (release = resolve));
    const pending = call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
    });
    await new Promise((r) => setTimeout(r, 50));
    market.proxy.abortServer("linear");
    release();
    const result = await pending;
    expect(result.status).toBe(404);
    expect((result.body as { id: number }).id).toBe(7);
  });

  it("does not add a server without login again when it was removed while being added", async () => {
    let release: () => void = () => undefined;
    lookupDelay = () => new Promise<void>((resolve) => (release = resolve));
    // Context7 needs no login; its check goes through the fake transport.
    const adding = market.connect("context7").catch((cause: Error) => cause.message);
    await new Promise((r) => setTimeout(r, 20));
    await market.remove("context7");
    lookupDelay = undefined;
    release();
    expect(await adding).toContain("取りやめ");
    expect(market.store.server("context7")).toBeUndefined();
  });

  it("lets one conversation open its servers at the same time", async () => {
    await connectLinear();
    await market.connect("context7");
    const servers = market.serversForSession({ ...session("together"), driver: "codex" });
    expect(servers.length).toBe(2);
    // Six requests at once over two servers from one credential.
    const results = await Promise.all(
      [...servers, ...servers, ...servers].map((server, id) =>
        call(server.url, server.authorizationHeader, { jsonrpc: "2.0", id, method: "tools/list" }),
      ),
    );
    expect(results.every((result) => result.status !== 429)).toBe(true);
  });

  it("keeps a long upstream session id working (Supabase uses token-like ids)", async () => {
    fake.sessionId = `long-${"x".repeat(1_500)}`;
    const server = await connectLinear();
    const init = await call(server.url, server.authorizationHeader, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(init.session).toBe(fake.sessionId);
    const listed = await call(
      server.url,
      server.authorizationHeader,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      fake.sessionId,
    );
    expect(listed.status).toBe(200);
  });
});
