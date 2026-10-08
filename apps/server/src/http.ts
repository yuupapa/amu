import * as Mime from "effect/http/Mime";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationV2AppThread,
  ThreadId,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { cast } from "effect/Function";
import {
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { OtlpTracer, OtlpSerialization } from "effect/observability";

import * as ServerConfig from "./config.ts";
import { findMcpMarketEntry } from "./amu/mcpMarket/catalog.ts";
import { McpMarket, setActiveMcpMarket } from "./amu/mcpMarket/market.ts";
import { McpMarketLoginError } from "./amu/mcpMarket/oauth.ts";
import { claudeLivePermissionMode, marketAllowsOutsideActions } from "./amu/mcpMarket/policy.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "./orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import { githubMediaResponse } from "./assets/GitHubMediaFetch.ts";
import { statMediaFile, streamMediaFile, type OpenMediaFile } from "./assets/MediaFile.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./assets/AttachmentUpload.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { WEBHOOK_ROUTE_PREFIX } from "./scheduledTasks/ScheduledTaskService.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  isLocalLunaAutoRequest,
  isLoopbackRemoteAddress,
} from "./httpCors.ts";
import { autoChoices, LUNA_JUDGE_NAMES } from "@t3tools/shared/lunaAuto";
import { cliReleaseNotes, hasCliReleaseNotes } from "./luna/CliReleaseNotes.ts";
import { judgeFoldersFromRequest } from "./luna/WorkFolderRequest.ts";
import { isThreadFolderId, readThreadFolderState, setThreadFolder } from "./luna/ThreadFolders.ts";
import { findCursorAgent, LunaDecisionBroker, type JudgeTarget } from "./luna/LunaDecision.ts";
import {
  lunaPreflightBlocked,
  resolveClaudeJudge,
  resolveCursorJudge,
  resolveLunaPreflight,
} from "./luna/LunaPreflight.ts";
import { applyLunaRoutingPolicy, loadLunaRoutingPolicy } from "./luna/LunaRoutingPolicy.ts";
import { deriveAuthClientMetadata } from "./auth/utils.ts";
import { expandHomePath } from "./pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "./provider/ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "./provider/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistry } from "./provider/ProviderRegistry.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// HTML previews are agent output, not the app. The sandbox gives the document an
// opaque origin: scripts run, but same-origin cookies, storage, and API calls are
// out of reach. Relative sibling assets still load through their signed URLs.
// No modals: agent HTML can open without a click (inline renders, and mobile
// loads it as the top document), and must not raise blocking dialogs.
const HTML_CONTENT_SECURITY_POLICY = "sandbox allow-scripts allow-forms allow-popups";

// Types a browser may render as a document if a proxy strips the disposition
// header. Downloads of these fall back to octet-stream.
const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());
const isSafeInlineMediaMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) && /^(?:audio|video)\//i.test(mimeType);
const isSafeInlineDocumentMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase() === "application/pdf" || mimeType.toLowerCase() === "text/html";

/** RFC 6266 disposition with an ASCII fallback name plus a UTF-8 `filename*`. */
export function downloadContentDisposition(fileName?: string): string {
  if (fileName === undefined) {
    return "attachment";
  }
  // toWellFormed: encodeURIComponent throws URIError on unpaired surrogates.
  const sanitized = fileName.toWellFormed().replace(/[\p{Cc}"\\]/gu, "_");
  const asciiFallback = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  const needsExtended = asciiFallback !== sanitized;
  const extendedName = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"${
    needsExtended ? `; filename*=UTF-8''${extendedName}` : ""
  }`;
}

export function assetResponseHeaders(
  filePath: string,
  options?: {
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
  },
): Record<string, string> {
  const lowerPath = filePath.toLowerCase();
  const inlineMimeType = options?.mimeType?.split(";", 1)[0]?.trim();
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(options?.download
      ? {
          "Content-Disposition": downloadContentDisposition(options.fileName),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type":
            options.mimeType !== undefined && isSafeDownloadMimeType(options.mimeType)
              ? options.mimeType
              : "application/octet-stream",
        }
      : inlineMimeType !== undefined && isSafeInlineMediaMimeType(inlineMimeType)
        ? { "Content-Type": inlineMimeType }
        : inlineMimeType !== undefined && isSafeInlineDocumentMimeType(inlineMimeType)
          ? {
              "Content-Type":
                inlineMimeType.toLowerCase() === "text/html"
                  ? "text/html; charset=utf-8"
                  : "application/pdf",
              ...(inlineMimeType.toLowerCase() === "text/html"
                ? { "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY }
                : {}),
            }
          : lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
            ? {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY,
              }
            : {}),
    ...(!options?.download && lowerPath.endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

/** A single byte range for native media readers; unsupported range syntax uses the full file. */
function assetByteRange(header: string, size: bigint) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first !== null && last !== null && last < first) return null;
  if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
    return { _tag: "Unsatisfiable" as const };
  }
  const start = first ?? (last! >= size ? 0n : size - last!);
  const end = first === null || last === null || last >= size ? size - 1n : last;
  if (!Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end))) {
    return { _tag: "Unsatisfiable" as const };
  }
  return {
    _tag: "Range" as const,
    offset: start,
    bytesToRead: end - start + 1n,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export const assetFileResponse = Effect.fn("assetFileResponse")(function* (
  asset: {
    readonly path: string;
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly file?: OpenMediaFile;
  },
  rangeHeader?: string,
  ifRangeHeader?: string,
  method: "GET" | "HEAD" = "GET",
) {
  const headers = assetResponseHeaders(asset.path, asset);
  const mediaFile = asset.file;
  const mediaInfo = mediaFile ? yield* statMediaFile(asset.path, mediaFile) : undefined;
  const isMedia = /^(?:audio|video)\//i.test(headers["Content-Type"] ?? "");
  if (isMedia) {
    // Host media can change in place. Do not invite conditional range requests
    // with validators that cannot establish byte-for-byte identity. Attachment media
    // carries no `file`, and must not outlive the signed URL that granted it either.
    headers["Cache-Control"] = "private, no-store";
  }
  let status = 200;
  let offset = 0n;
  let bytesToRead: bigint | undefined;
  if (isMedia) {
    headers["Accept-Ranges"] = "bytes";
    // If-Range requires a matching validator. A full response is safe when we cannot validate it.
    if (method === "GET" && rangeHeader && ifRangeHeader === undefined) {
      const fs = yield* FileSystem.FileSystem;
      const info = mediaInfo ?? (yield* fs.stat(asset.path));
      const range = assetByteRange(rangeHeader, info.size);
      if (range?._tag === "Unsatisfiable") {
        return HttpServerResponse.empty({
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${info.size}` },
        });
      }
      if (range?._tag === "Range") {
        status = 206;
        offset = range.offset;
        bytesToRead = range.bytesToRead;
        headers["Content-Range"] = range.contentRange;
      }
    }
  }
  if (mediaFile && mediaInfo) {
    const size = bytesToRead ?? mediaInfo.size;
    headers["Content-Type"] ??= Option.getOrElse(
      Mime.getType(asset.path),
      () => "application/octet-stream",
    );
    headers["Content-Length"] = String(size);
    if (!isMedia) {
      headers["Last-Modified"] = mediaInfo.mtime.toUTCString();
      headers.ETag = `W/"${mediaInfo.size.toString(16)}-${mediaInfo.mtimeMs.toString(16)}"`;
    }
    if (method === "HEAD" || size === 0n) {
      return HttpServerResponse.empty({ status, headers });
    }
    const body = streamMediaFile(mediaFile, offset, size);
    if (!body) {
      return HttpServerResponse.text("File is too large to preview.", { status: 413 });
    }
    return HttpServerResponse.stream(body, {
      status,
      headers,
    });
  }
  return yield* HttpServerResponse.file(asset.path, { status, offset, bytesToRead, headers });
});

export const layerHttpCompression = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const layerBrowserApiCors = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const layerServerEnvironmentHttpApi = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
}> {}

// Renderers export up to once a second while they have spans buffered, so
// tracing this proxy would add more server spans than it forwards.
// withTracerEnabled(false) drops the handler's spans, including the forward.
// untracedRequestsLayer drops the HTTP server span.
export const layerOtlpTracesProxyRoute = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const otlpHeaders = config.otlpTracesExport.headers;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const serialization = yield* OtlpSerialization.OtlpSerialization;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) => Effect.logWarning("Failed to decode browser OTLP traces", { cause })),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: serialization.traces(bodyJson),
        headers: otlpHeaders,
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.withTracerEnabled(false),
  ),
);

const UNTRACED_REQUEST_PATHS: ReadonlySet<string> = new Set([OTLP_TRACES_PROXY_PATH]);

// Skips the HTTP server span for UNTRACED_REQUEST_PATHS. That span starts
// before routing, so a route handler cannot skip it. TracerDisabledWhen is one
// predicate for the whole server, and HttpRouter.serve builds its routes
// privately, so it is provided to the served layer, never merged into the
// routes. Add paths here instead of providing it again. The query string is
// ignored, as in routing.
const layerUntracedRequests = Layer.succeed(HttpMiddleware.TracerDisabledWhen)((request) => {
  const queryIndex = request.url.indexOf("?");
  const path = queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
  // Webhook URLs carry their secret token in the path, so they never reach a trace.
  return UNTRACED_REQUEST_PATHS.has(path) || path.startsWith(`${WEBHOOK_ROUTE_PREFIX}/`);
});

export const withUntracedRequests = Layer.provide(layerUntracedRequests);

export const layerAssetRoute = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (asset.kind === "bytes") {
      return HttpServerResponse.uint8Array(asset.bytes, {
        contentType: asset.mimeType,
        headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
      });
    }
    if (asset.kind === "github-media") {
      return yield* githubMediaResponse(asset, request.headers).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to fetch GitHub media.", { url: asset.url, cause }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.empty({
            status: 502,
            headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
          }),
        ),
      );
    }
    return yield* assetFileResponse(
      asset,
      request.method === "GET" ? request.headers.range : undefined,
      request.headers["if-range"],
      request.method === "HEAD" ? "HEAD" : "GET",
    ).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

/**
 * Amu routes: the request body, read with a cap so an oversized (or chunked)
 * body is refused while it is read, not after. Null when it is too large.
 */
const readCappedBody = (request: HttpServerRequest.HttpServerRequest, maxBytes: number) => {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return Effect.succeed(null);
  return request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBytes)),
    Effect.map((text) => (Buffer.byteLength(text) > maxBytes ? null : text)),
    Effect.orElseSucceed(() => null),
  );
};

// Amu: Luna picks the model for the first request of a thread (docs/user/luna-auto.md).
export type LunaAutoRouteOptions = {
  /** The connecting peer's address; the Host header alone can be set to anything. */
  readonly peerAddress?: (request: HttpServerRequest.HttpServerRequest) => string | undefined;
};
const socketPeerAddress = (request: HttpServerRequest.HttpServerRequest) =>
  deriveAuthClientMetadata({ request }).ipAddress;

export const makeLunaAutoRouteLayer = (options: LunaAutoRouteOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const providers = yield* ProviderRegistry;
      const settings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const broker = new LunaDecisionBroker();
      yield* Effect.addFinalizer(() => Effect.sync(() => broker.close()));
      return HttpRouter.add(
        "POST",
        "/api/luna-auto",
        Effect.gen(function* () {
          yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          const remoteAddress = (options.peerAddress ?? socketPeerAddress)(request);
          if (
            Option.isNone(url) ||
            !isLocalLunaAutoRequest(url.value, request.headers, remoteAddress)
          )
            return HttpServerResponse.jsonUnsafe(
              { error: "オートはこのMacのローカルのAmuで利用してください。" },
              { status: 403 },
            );
          const body = yield* readCappedBody(request, 64_000);
          if (body === null)
            return HttpServerResponse.jsonUnsafe(
              { error: "入力サイズが上限を超えています。" },
              { status: 400 },
            );
          const data = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(body).pipe(Effect.orElseSucceed(() => null));
          // A single-use id from this server; every judgement needs one.
          if (data?.action === "issue")
            return HttpServerResponse.jsonUnsafe({ result: broker.issue() });
          if (!data || typeof data.id !== "string" || !/^[a-zA-Z0-9-]{20,80}$/.test(data.id))
            return HttpServerResponse.jsonUnsafe(
              { error: "モデル選択の形式が不正です。" },
              { status: 400 },
            );
          if (data.action === "cancel") {
            return HttpServerResponse.jsonUnsafe({ cancelled: broker.cancel(data.id) });
          }
          if (
            data.action !== "decide" ||
            typeof data.prompt !== "string" ||
            !data.prompt.trim() ||
            data.prompt.length > 24_000 ||
            !Array.isArray(data.models)
          )
            return HttpServerResponse.jsonUnsafe(
              { error: "依頼文または利用可能モデルが不正です。" },
              { status: 400 },
            );
          const snapshots = yield* providers.getProviders;
          const currentSettings = yield* settings.getSettings;
          const allowedModels = data.models;
          const choices = autoChoices(
            snapshots.map((p) => ({
              ...p,
              models: p.models.filter((model) =>
                allowedModels.some(
                  (m: unknown) =>
                    m !== null &&
                    typeof m === "object" &&
                    "instanceId" in m &&
                    "model" in m &&
                    m.instanceId === p.instanceId &&
                    m.model === model.slug,
                ),
              ),
            })),
          );
          const configMap = deriveProviderInstanceConfigMap(currentSettings);
          const blocked = (result: { error: string; code: string }) =>
            HttpServerResponse.jsonUnsafe(
              { error: result.error, code: result.code },
              { status: 400 },
            );
          if (!choices.length) return blocked(lunaPreflightBlocked("choices_unavailable"));
          // 結パパ's routing table: which model fits which kind of request.
          const policy = loadLunaRoutingPolicy(serverConfig.stateDir);
          const routedChoices = applyLunaRoutingPolicy(choices, policy);
          // Every connected AI that can judge, in the policy's order (Haiku, Luna, Composer).
          const codex = resolveLunaPreflight(snapshots, configMap, choices);
          const judges: JudgeTarget[] = [];
          for (const kind of policy.judges) {
            const name = LUNA_JUDGE_NAMES[kind];
            if (kind === "codex" && codex.ok) {
              judges.push({
                kind,
                name,
                runtime: {
                  binary: expandHomePath(codex.config.binaryPath),
                  home:
                    codex.judge.runtimePaths?.shadowHomePath ??
                    codex.judge.runtimePaths?.homePath ??
                    expandHomePath(codex.config.homePath),
                  environment: mergeProviderInstanceEnvironment(codex.instance.environment),
                },
              });
            } else if (kind === "claude") {
              const claude = resolveClaudeJudge(snapshots, configMap);
              if (claude.ok)
                judges.push({
                  kind,
                  name,
                  runtime: {
                    binary: expandHomePath(claude.config.binaryPath),
                    home:
                      claude.provider.runtimePaths?.homePath ??
                      (claude.config.homePath ? expandHomePath(claude.config.homePath) : ""),
                    environment: mergeProviderInstanceEnvironment(claude.instance.environment),
                  },
                });
            } else if (kind === "cursor") {
              const cursor = resolveCursorJudge(snapshots, configMap);
              if (!cursor.ok) continue;
              const environment = mergeProviderInstanceEnvironment(cursor.instance.environment);
              const binary = findCursorAgent(
                cursor.config.binaryPath ? expandHomePath(cursor.config.binaryPath) : undefined,
                environment,
              );
              if (binary) judges.push({ kind, name, runtime: { binary, home: "", environment } });
            }
          }
          if (!judges.length)
            return blocked(
              codex.ok || !policy.judges.includes("codex")
                ? lunaPreflightBlocked("no_judge")
                : codex,
            );
          const id = data.id,
            prompt = data.prompt;
          // Earlier work folders, when the client asks Auto to pick the folder too.
          const folders = policy.autoFolder
            ? judgeFoldersFromRequest(data.folders, serverConfig.stateDir)
            : null;
          // Keep the original rejection message; the default catcher replaces it with a generic UnknownError.
          return yield* Effect.tryPromise({
            try: () =>
              broker.decide(id, {
                prompt,
                choices: routedChoices,
                guidance: policy.guidance,
                judges,
                ...(folders ? { folders: folders.judge } : {}),
              }),
            catch: (error) =>
              error instanceof Error ? error.message : "Lunaの結果が不明です。自動再送はしません。",
          }).pipe(
            Effect.map(({ decision: { folder, ...decision }, judge }) =>
              HttpServerResponse.jsonUnsafe({
                result: decision,
                judge,
                folder: folders && folder !== undefined ? folders.resolve(folder) : null,
              }),
            ),
            Effect.catch((message) =>
              Effect.succeed(HttpServerResponse.jsonUnsafe({ error: message }, { status: 400 })),
            ),
          );
        }),
      );
    }),
  );

export const layerLunaAutoRoute = makeLunaAutoRouteLayer();

// Amu: what a CLI update changes, in Japanese, for the update notice (docs/user/updating.md).
export const makeCliReleaseNotesRouteLayer = (options: LunaAutoRouteOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const providers = yield* ProviderRegistry;
      const settings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      return HttpRouter.add(
        "POST",
        "/api/amu/cli-release-notes",
        Effect.gen(function* () {
          yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          const remoteAddress = (options.peerAddress ?? socketPeerAddress)(request);
          if (
            Option.isNone(url) ||
            !isLocalLunaAutoRequest(url.value, request.headers, remoteAddress)
          )
            return HttpServerResponse.jsonUnsafe(
              { error: "このMacのローカルのAmuで利用してください。" },
              { status: 403 },
            );
          const body = yield* readCappedBody(request, 4_000);
          if (body === null)
            return HttpServerResponse.jsonUnsafe(
              { error: "入力が大きすぎます。" },
              { status: 400 },
            );
          const data = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(body).pipe(Effect.orElseSucceed(() => null));
          const version = /^v?\d+(?:\.\d+){1,3}$/;
          if (
            !data ||
            typeof data.driver !== "string" ||
            typeof data.currentVersion !== "string" ||
            typeof data.latestVersion !== "string" ||
            !version.test(data.currentVersion) ||
            !version.test(data.latestVersion)
          )
            return HttpServerResponse.jsonUnsafe({ error: "形式が不正です。" }, { status: 400 });
          if (!hasCliReleaseNotes(data.driver))
            return HttpServerResponse.jsonUnsafe({ result: null });
          const snapshots = yield* providers.getProviders;
          const currentSettings = yield* settings.getSettings;
          const claude = resolveClaudeJudge(
            snapshots,
            deriveProviderInstanceConfigMap(currentSettings),
          );
          const haikuRuntime = claude.ok
            ? {
                binary: expandHomePath(claude.config.binaryPath),
                home:
                  claude.provider.runtimePaths?.homePath ??
                  (claude.config.homePath ? expandHomePath(claude.config.homePath) : ""),
                environment: mergeProviderInstanceEnvironment(claude.instance.environment),
              }
            : null;
          const input = {
            driver: data.driver,
            currentVersion: data.currentVersion,
            latestVersion: data.latestVersion,
          };
          return yield* Effect.tryPromise({
            try: (signal) =>
              cliReleaseNotes({
                ...input,
                stateDir: serverConfig.stateDir,
                haikuRuntime,
                signal,
              }),
            catch: () => "更新内容を取得できませんでした。",
          }).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe({ result })),
            Effect.catch((message) =>
              Effect.succeed(HttpServerResponse.jsonUnsafe({ error: message }, { status: 502 })),
            ),
          );
        }),
      );
    }),
  );

export const layerCliReleaseNotesRoute = makeCliReleaseNotesRouteLayer();

// Amu: which project a thread is listed under in the sidebar (docs/user/thread-sidebar.md).
export const layerThreadFoldersRoute = Layer.unwrap(
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const read = HttpRouter.add(
      "GET",
      "/api/amu/thread-folders",
      Effect.gen(function* () {
        yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
        const state = readThreadFolderState(serverConfig.stateDir);
        return HttpServerResponse.jsonUnsafe({ result: state.entries, revision: state.revision });
      }),
    );
    const write = HttpRouter.add(
      "POST",
      "/api/amu/thread-folders",
      Effect.gen(function* () {
        yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* readCappedBody(request, 4_000);
        if (body === null)
          return HttpServerResponse.jsonUnsafe({ error: "入力が大きすぎます。" }, { status: 400 });
        const data = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(body).pipe(Effect.orElseSucceed(() => null));
        if (
          !data ||
          !isThreadFolderId(data.threadId) ||
          !(data.projectId === null || isThreadFolderId(data.projectId))
        )
          return HttpServerResponse.jsonUnsafe({ error: "形式が不正です。" }, { status: 400 });
        const threadId = data.threadId,
          projectId = data.projectId;
        return yield* Effect.try({
          try: () => setThreadFolder(serverConfig.stateDir, threadId, projectId),
          catch: () => "保存できませんでした。",
        }).pipe(
          Effect.map((state) =>
            HttpServerResponse.jsonUnsafe({ result: state.entries, revision: state.revision }),
          ),
          Effect.catch((message) =>
            Effect.succeed(HttpServerResponse.jsonUnsafe({ error: message }, { status: 500 })),
          ),
        );
      }),
    );
    return Layer.mergeAll(read, write);
  }),
);

// Amu: the MCP market (docs/internals/amu-mcp-market.md). Anyone signed in
// may read the cards; connecting and removing only from this Mac's desktop app.
const authenticateDesktopRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  const remoteAddress = socketPeerAddress(request);
  return {
    session,
    // The desktop app's own session (only the desktop-bootstrap grant issues
    // that subject) on a loopback socket. Tailscale serving forwards remote
    // clients to loopback, so the address alone would not do.
    desktop:
      session.subject === "desktop-bootstrap" &&
      session.scopes.includes(AuthOrchestrationOperateScope) &&
      remoteAddress !== undefined &&
      isLoopbackRemoteAddress(remoteAddress),
  };
});

const layerMcpMarketRouteUnprovided = Layer.unwrap(
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const threads = yield* ThreadManagement.ThreadManagementService;
    // The same policy the provider sessions are set up with (the adapters'
    // turn policy comes from this service too).
    const policies = yield* RuntimePolicy.RuntimePolicyV2;
    const context = yield* Effect.context<never>();
    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromiseWith(context)(effect.pipe(Effect.orElseSucceed(() => undefined as A)));
    const market = yield* Effect.acquireRelease(
      Effect.promise(() =>
        McpMarket.start({
          stateDir: serverConfig.stateDir,
          secretsDir: serverConfig.secretsDir,
          hooks: {
            allowsOutsideActions: async (credential) => {
              const shell = await run(threads.getThreadShell(ThreadId.make(credential.threadId)));
              if (!shell || shell.deletedAt !== null) return false;
              // The resolver reads only runtimeMode, interactionMode,
              // worktreePath and projectId, which a shell has.
              const policy = await run(
                policies.resolve({
                  thread: shell as unknown as OrchestrationV2AppThread,
                  modelSelection: shell.modelSelection,
                }),
              );
              if (!policy) return false;
              return marketAllowsOutsideActions({
                driver: credential.driver,
                policy,
                claudeLivePermissionMode: claudeLivePermissionMode(credential.providerSessionId),
              });
            },
          },
        }),
      ).pipe(Effect.tap((started) => Effect.sync(() => setActiveMcpMarket(started)))),
      (started) =>
        Effect.sync(() => {
          setActiveMcpMarket(undefined);
          started.close();
        }),
    );
    const read = HttpRouter.add(
      "GET",
      "/api/amu/mcp-market",
      Effect.gen(function* () {
        const { desktop } = yield* authenticateDesktopRoute;
        return HttpServerResponse.jsonUnsafe({ result: market.cards(), canManage: desktop });
      }),
    );
    const write = HttpRouter.add(
      "POST",
      "/api/amu/mcp-market",
      Effect.gen(function* () {
        const { desktop } = yield* authenticateDesktopRoute;
        if (!desktop)
          return HttpServerResponse.jsonUnsafe(
            { error: "MCP の追加と削除は、この Mac の Amu からだけできます。" },
            { status: 403 },
          );
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* readCappedBody(request, 2_000);
        const data =
          body === null
            ? null
            : yield* Schema.decodeEffect(
                Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
              )(body).pipe(Effect.orElseSucceed(() => null));
        const id = typeof data?.id === "string" ? data.id : "";
        if (
          !data ||
          !findMcpMarketEntry(id) ||
          !["connect", "remove"].includes(String(data.action))
        )
          return HttpServerResponse.jsonUnsafe({ error: "形式が不正です。" }, { status: 400 });
        return yield* Effect.tryPromise({
          try: async () =>
            data.action === "remove"
              ? (await market.remove(id), { result: market.cards() })
              : { authorizationUrl: await market.connect(id), result: market.cards() },
          catch: (cause) =>
            cause instanceof McpMarketLoginError ? cause.message : "接続を始められませんでした。",
        }).pipe(
          Effect.map((answer) => HttpServerResponse.jsonUnsafe(answer)),
          Effect.catch((message) =>
            Effect.succeed(HttpServerResponse.jsonUnsafe({ error: message }, { status: 502 })),
          ),
        );
      }),
    );
    return Layer.mergeAll(read, write);
  }),
);

export const layerMcpMarketRoute = layerMcpMarketRouteUnprovided.pipe(
  Layer.provide(RuntimePolicy.layerFromProjectStore.pipe(Layer.provide(ProjectStore.layer))),
);

export const layerAttachmentUploadRoute = HttpRouter.add(
  "POST",
  `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const token = url.value.pathname.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
    if (!token) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const claims = yield* validateAttachmentUploadToken(token);
    if (!claims) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const contentLengthHeader = request.headers["content-length"];
    if (
      contentLengthHeader !== undefined &&
      (!Number.isInteger(Number(contentLengthHeader)) ||
        Number(contentLengthHeader) !== claims.sizeBytes)
    ) {
      return HttpServerResponse.text("Content-Length must match the upload size.", {
        status: 400,
      });
    }

    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* storeAttachmentUpload(claims, Stream.fromPull(Effect.succeed(bodyPull)));
    return stored.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
);

const decodeBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const loadImmutableBuildAssets = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  if (!staticDir) return new Set<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(staticDir, ".vite", "manifest.json")).pipe(
    Effect.flatMap(decodeBuildManifest),
    Effect.map(
      (manifest) =>
        new Set(
          Object.values(manifest).flatMap((entry) => [
            entry.file,
            ...(entry.css ?? []),
            ...(entry.assets ?? []),
          ]),
        ),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

const openStaticFile = Effect.fn("openStaticFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // Reject directories and special files before opening. Response metadata comes from the handle.
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" });
  const info = yield* file.stat;
  return info.type === "File" ? { file, info } : null;
});

const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(Number(remaining < 65_536n ? remaining : 65_536n));
      if (Option.isNone(bytes)) return;
      return [bytes.value, offset + BigInt(bytes.value.byteLength)] as const;
    }),
  );

const handleStaticAndDevRequest = Effect.fn("handleStaticAndDevRequest")(
  function* (immutableBuildAssets: ReadonlySet<string>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    let opened = yield* openStaticFile(filePath);
    if (!opened) {
      filePath = path.resolve(staticRoot, "index.html");
      opened = yield* openStaticFile(filePath);
      if (!opened) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }
    const fileInfo = opened.info;
    const mimeType = Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const headers: Record<string, string> = {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    // Deployments can preserve HTML size and mtime while changing its bundle URLs.
    const modifiedAt = isHtml ? undefined : Option.getOrUndefined(fileInfo.mtime);
    const etag = modifiedAt
      ? `W/"${fileInfo.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`
      : undefined;
    if (etag !== undefined && modifiedAt !== undefined) {
      headers.ETag = etag;
      headers["Last-Modified"] = modifiedAt.toUTCString();
    }

    // If-None-Match takes precedence over dates and uses weak comparison for
    // GET/HEAD, including when compression changes the transferred bytes.
    const ifNoneMatch = request.headers["if-none-match"];
    const ifModifiedSince = request.headers["if-modified-since"];
    const unchanged =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(",").some((value) => {
            const candidate = value.trim();
            return (
              candidate === "*" ||
              (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
            );
          })
        : ifModifiedSince !== undefined &&
          modifiedAt !== undefined &&
          Date.parse(modifiedAt.toUTCString()) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    // HEAD still passes through compression, which selects headers without reading the stream.
    return HttpServerResponse.stream(streamStaticFile(opened.file, fileInfo.size), {
      headers,
      contentType,
      contentLength: Number(fileInfo.size),
    });
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

// Read the installed build's manifest once. Unknown files use revalidation.
export const layerStaticAndDevRoute = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);
