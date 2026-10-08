// @effect-diagnostics nodeBuiltinImport:off globalDate:off - two small files beside Amu's other state and secrets, written atomically under a per-server lock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Amu MCP market: which servers are added, and their login secrets
 * (docs/internals/amu-mcp-market.md, "Connection state"). `generation` is a
 * per-server counter that rises on every add and is never reused, so a
 * credential bound to an older add stays refused after a remove and re-add.
 * Every change to a server's state or secret runs under that server's lock.
 */

const STATE_FILE = "mcp-market.json";
const SECRET_PREFIX = "amu-mcp-market-";
const ID = /^[a-z0-9-]{1,40}$/u;

export interface McpMarketServerState {
  readonly addedAt: string;
  readonly generation: number;
}

interface StateFile {
  readonly version: 1;
  readonly revision: number;
  readonly servers: Readonly<Record<string, McpMarketServerState>>;
  /** The last generation handed out per server, kept after a remove. */
  readonly generations: Readonly<Record<string, number>>;
  /** Random per installation; part of the MCP server names (catalog.ts). */
  readonly installSuffix?: string;
}

export interface McpMarketSecret {
  readonly generation: number;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  readonly redirectUri: string;
  readonly issuer: string;
  readonly resource: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms; absent when the server gave no lifetime. */
  readonly expiresAt?: number;
  /** Rises on every stored token (login or refresh). */
  readonly tokenGeneration: number;
  /** Rises on every successful login. */
  readonly authVersion: number;
  /** Set when a refresh failed or the server kept refusing the token. */
  readonly needsLogin?: boolean;
}

/** The registration kept per issuer and redirect, reused for the next login. */
export interface McpMarketClientRegistration {
  readonly issuer: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod: McpMarketSecret["tokenEndpointAuthMethod"];
}

const emptyState = (): StateFile => ({ version: 1, revision: 0, servers: {}, generations: {} });

function writeAtomic(file: string, data: string): void {
  const temporary = `${file}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporary, data, { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
}

export class McpMarketStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  private readonly stateDir: string;
  private readonly secretsDir: string;

  constructor(stateDir: string, secretsDir: string) {
    this.stateDir = stateDir;
    this.secretsDir = secretsDir;
  }

  /** Runs `work` alone for this server: no other change to it overlaps. */
  withLock<T>(id: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return next;
  }

  readState(): StateFile {
    try {
      const value = JSON.parse(
        NodeFS.readFileSync(NodePath.join(this.stateDir, STATE_FILE), "utf8"),
      ) as Partial<StateFile>;
      if (value?.version !== 1 || typeof value.servers !== "object" || value.servers === null)
        return emptyState();
      const servers: Record<string, McpMarketServerState> = {};
      for (const [id, server] of Object.entries(value.servers)) {
        if (
          ID.test(id) &&
          server &&
          typeof server.addedAt === "string" &&
          Number.isSafeInteger(server.generation)
        )
          servers[id] = { addedAt: server.addedAt, generation: server.generation };
      }
      const generations: Record<string, number> = {};
      for (const [id, generation] of Object.entries(value.generations ?? {})) {
        if (ID.test(id) && Number.isSafeInteger(generation)) generations[id] = generation;
      }
      return {
        version: 1,
        revision: Number.isSafeInteger(value.revision) ? value.revision! : 0,
        servers,
        generations,
        ...(typeof value.installSuffix === "string" && /^[a-f0-9]{6}$/u.test(value.installSuffix)
          ? { installSuffix: value.installSuffix }
          : {}),
      };
    } catch {
      return emptyState();
    }
  }

  private writeState(state: StateFile): void {
    NodeFS.mkdirSync(this.stateDir, { recursive: true });
    writeAtomic(NodePath.join(this.stateDir, STATE_FILE), JSON.stringify(state));
  }

  /** This installation's name suffix, made once and kept. */
  installSuffix(): string {
    const state = this.readState();
    if (state.installSuffix) return state.installSuffix;
    const installSuffix = NodeCrypto.randomBytes(3).toString("hex");
    this.writeState({ ...state, installSuffix });
    return installSuffix;
  }

  /** The server's state when it is added, else undefined. */
  server(id: string): McpMarketServerState | undefined {
    return this.readState().servers[id];
  }

  /** Call under the lock. Adds the server with a new generation and returns it. */
  addLocked(id: string, now = new Date()): McpMarketServerState {
    const state = this.readState();
    const generation = (state.generations[id] ?? 0) + 1;
    const server = { addedAt: now.toISOString(), generation };
    this.writeState({
      ...state,
      revision: state.revision + 1,
      servers: { ...state.servers, [id]: server },
      generations: { ...state.generations, [id]: generation },
    });
    return server;
  }

  /** Call under the lock. Removes the server's state and secret. */
  removeLocked(id: string): void {
    const state = this.readState();
    if (state.servers[id] !== undefined) {
      const servers = { ...state.servers };
      delete servers[id];
      this.writeState({ ...state, revision: state.revision + 1, servers });
    }
    NodeFS.rmSync(this.secretFile(id), { force: true });
  }

  private secretFile(id: string): string {
    if (!ID.test(id)) throw new Error("bad server id");
    return NodePath.join(this.secretsDir, `${SECRET_PREFIX}${id}.json`);
  }

  /** The secret, only when it belongs to the server's current generation. */
  secret(id: string): McpMarketSecret | undefined {
    const server = this.server(id);
    if (server === undefined) return undefined;
    try {
      const value = JSON.parse(NodeFS.readFileSync(this.secretFile(id), "utf8")) as McpMarketSecret;
      return value.generation === server.generation && typeof value.accessToken === "string"
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Call under the lock. */
  writeSecretLocked(id: string, secret: McpMarketSecret): void {
    NodeFS.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    writeAtomic(this.secretFile(id), JSON.stringify(secret));
  }

  private registrationsFile(): string {
    return NodePath.join(this.secretsDir, `${SECRET_PREFIX}clients.json`);
  }

  registration(issuer: string, redirectUri: string): McpMarketClientRegistration | undefined {
    try {
      const list = JSON.parse(
        NodeFS.readFileSync(this.registrationsFile(), "utf8"),
      ) as McpMarketClientRegistration[];
      return list.find((item) => item.issuer === issuer && item.redirectUri === redirectUri);
    } catch {
      return undefined;
    }
  }

  saveRegistration(registration: McpMarketClientRegistration): void {
    let list: McpMarketClientRegistration[] = [];
    try {
      list = JSON.parse(NodeFS.readFileSync(this.registrationsFile(), "utf8"));
    } catch {
      list = [];
    }
    const next = [
      ...list.filter(
        (item) =>
          !(item.issuer === registration.issuer && item.redirectUri === registration.redirectUri),
      ),
      registration,
    ].slice(-50);
    NodeFS.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    writeAtomic(this.registrationsFile(), JSON.stringify(next));
  }
}
