// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - HTTPS to a checked public address, with a time limit; Effect has no way to pin the address a TLS connection uses.
import type * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

import { publicAddresses } from "../../htmlRender/publicProxy.ts";
import { isAllowedMarketUrl, type McpMarketEntry } from "./catalog.ts";

/**
 * Amu MCP market: every request the market sends upstream goes through here
 * (docs/internals/amu-mcp-market.md, "Login" step 2 and "Proxy"). Only HTTPS
 * to one of the entry's allowed origins; the host is resolved once, every
 * address must be public, and the connection goes to exactly those addresses,
 * so a name that later resolves elsewhere changes nothing. Redirects are
 * never followed: a 3xx comes back to the caller as it is.
 */

export interface MarketRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
  /** Until the response headers arrive. */
  readonly headerTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Runs after the address is resolved, right before the request is made; a
   * rejection stops it (the proxy re-checks the add and the thread's mode).
   */
  readonly beforeSend?: () => Promise<void>;
}

export interface MarketResponse {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** Opens a request and resolves with the response once its headers are in. */
export type MarketTransport = (
  entry: McpMarketEntry,
  request: MarketRequest,
) => Promise<NodeHttp.IncomingMessage>;

export class MarketFetchError extends Error {
  readonly reason: "not_allowed" | "not_public" | "timeout" | "network" | "too_large";
  constructor(message: string, reason: MarketFetchError["reason"]) {
    super(message);
    this.reason = reason;
  }
}

const HEADER_TIMEOUT_MS = 15_000;

export const httpsTransport: MarketTransport = async (entry, request) => {
  if (!isAllowedMarketUrl(entry, request.url))
    throw new MarketFetchError("この接続先には送れません。", "not_allowed");
  const url = new URL(request.url);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  // The name lookup counts toward the time limit and stops with the signal.
  const addresses = await new Promise<Awaited<ReturnType<typeof publicAddresses>>>(
    (resolve, reject) => {
      const fail = () => reject(new MarketFetchError("接続先が応答しません。", "timeout"));
      if (request.signal?.aborted) return fail();
      const timer = setTimeout(fail, request.headerTimeoutMs ?? HEADER_TIMEOUT_MS);
      request.signal?.addEventListener("abort", fail, { once: true });
      publicAddresses(host).then(
        (value) => {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", fail);
          resolve(value);
        },
        (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      );
    },
  );
  if (!addresses) throw new MarketFetchError("この接続先には送れません。", "not_public");
  await request.beforeSend?.();
  return await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    const outgoing = NodeHttps.request(
      {
        method: request.method,
        protocol: "https:",
        host,
        servername: host,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        agent: false,
        // Connect only to the addresses checked above.
        lookup: (_hostname, options, callback) => {
          const all = (options as { all?: boolean }).all === true;
          if (all) (callback as (error: null, list: typeof addresses) => void)(null, addresses);
          else
            (callback as (error: null, address: string, family: number) => void)(
              null,
              addresses[0]!.address,
              addresses[0]!.family,
            );
        },
        ...(request.signal ? { signal: request.signal } : {}),
      },
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    );
    const timer = setTimeout(() => {
      outgoing.destroy(new MarketFetchError("接続先が応答しません。", "timeout"));
    }, request.headerTimeoutMs ?? HEADER_TIMEOUT_MS);
    outgoing.once("error", (cause) => {
      clearTimeout(timer);
      reject(
        cause instanceof MarketFetchError
          ? cause
          : new MarketFetchError("接続先につながりませんでした。", "network"),
      );
    });
    if (request.body !== undefined) outgoing.end(request.body);
    else outgoing.end();
  });
};

/** A whole (small) response, at most `maxBytes`. */
export async function readMarketResponse(
  response: NodeHttp.IncomingMessage,
  maxBytes: number,
): Promise<MarketResponse> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const data = chunk as Buffer;
    size += data.length;
    if (size > maxBytes) {
      response.destroy();
      throw new MarketFetchError("応答が大きすぎます。", "too_large");
    }
    chunks.push(data);
  }
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks),
  };
}

export const MARKET_USER_AGENT = `Amu/${process.env.npm_package_version ?? "1"} (MCP market)`;
