/**
 * Local type stubs for `@omadia/plugin-api`.
 *
 * The real package is provided by the omadia host at runtime — it is NOT
 * published to npm, so you do not (and cannot) `npm install` it. These ambient
 * declarations mirror the host's public surface closely enough to compile this
 * plugin offline. At runtime the host injects the genuine implementations.
 *
 * Only the slice of `PluginContext` this plugin actually uses is declared
 * (secrets, config, services, http, memory, jobs, status, tools, log). Kept in sync
 * with the boilerplate `agent-integration/types.ts` of the targeted core.
 */
declare module '@omadia/plugin-api' {
  /** Vault-backed secrets declared as `type: secret` setup fields. */
  export interface SecretsAccessor {
    get(key: string): Promise<string | undefined>;
    require(key: string): Promise<string>;
    keys(): Promise<string[]>;
  }

  /** Plain (non-secret) setup fields from manifest `setup.fields`. */
  export interface ConfigAccessor {
    get<T = unknown>(key: string): T | undefined;
    require<T = unknown>(key: string): T;
  }

  /** Cross-plugin service registry. Keys are strings; contracts by convention. */
  export interface ServicesAccessor {
    get<T>(name: string): T | undefined;
    has(name: string): boolean;
    provide<T>(name: string, impl: T): () => void;
  }

  /** Outbound-allowlisted fetch. Same shape as global `fetch`; unknown hosts
   *  throw `HttpForbiddenError`, rate-limit breaches throw `HttpRateLimitError`.
   *  Present iff the manifest declares `permissions.network.outbound`. */
  export interface HttpAccessor {
    fetch(url: string, init?: RequestInit): Promise<Response>;
  }

  export interface MemoryEntryInfo {
    readonly relPath: string;
    readonly isDirectory: boolean;
    readonly sizeBytes: number;
  }

  /** Per-plugin memory store, scoped to `/memories/agents/<agentId>/`. All
   *  paths are relative. Present iff the manifest declares `permissions.memory`. */
  export interface MemoryAccessor {
    readFile(relPath: string): Promise<string>;
    writeFile(relPath: string, content: string): Promise<void>;
    createFile(relPath: string, content: string): Promise<void>;
    delete(relPath: string): Promise<void>;
    list(relPath: string): Promise<readonly MemoryEntryInfo[]>;
    exists(relPath: string): Promise<boolean>;
  }

  export type JobSchedule =
    | { readonly cron: string }
    | { readonly intervalMs: number };

  export interface JobSpec {
    readonly name: string;
    readonly schedule: JobSchedule;
    readonly timeoutMs?: number;
    readonly overlap?: 'skip' | 'queue';
  }

  /** Handler invoked on each scheduled tick. The AbortSignal is aborted on
   *  deactivate or when `timeoutMs` elapses — respect it. */
  export type JobHandler = (signal: AbortSignal) => Promise<void>;

  export interface JobsAccessor {
    register(spec: JobSpec, handler: JobHandler): () => void;
  }

  export type PluginActionState = 'ok' | 'needs_action' | 'error';

  export interface PluginActionStatus {
    readonly state: PluginActionState;
    readonly title?: string;
    readonly detail?: string;
  }

  /** Operator-facing plugin health badge. Always present. */
  export interface StatusAccessor {
    report(status: PluginActionStatus): void;
    clear(): void;
  }

  /** Tool spec in the shape the Anthropic Messages API accepts. */
  export interface NativeToolSpec {
    readonly name: string;
    readonly description: string;
    readonly input_schema: {
      readonly type: 'object';
      readonly properties: Record<string, unknown>;
      readonly required?: readonly string[];
    };
    readonly domain?: string;
  }

  /** Handler a plugin hands the kernel with the spec; returns the tool-use reply. */
  export type NativeToolHandler = (input: unknown) => Promise<string>;

  /** Tool runtime: contributes a tool to the agents this plugin is granted to.
   *  Returns a dispose handle that `close()` MUST call. */
  export interface ToolsAccessor {
    register(spec: NativeToolSpec, handler: NativeToolHandler): () => void;
  }

  export interface PluginContext {
    readonly agentId: string;
    readonly secrets: SecretsAccessor;
    readonly config: ConfigAccessor;
    readonly services: ServicesAccessor;
    /** Present iff manifest declares `permissions.network.outbound`. */
    readonly http?: HttpAccessor;
    /** Present iff manifest declares `permissions.memory`. */
    readonly memory?: MemoryAccessor;
    /** Always present; no permission gate. */
    readonly jobs: JobsAccessor;
    /** Always present; no permission gate. */
    readonly status: StatusAccessor;
    /** Tool runtime (kernel >=1.75.0). */
    readonly tools: ToolsAccessor;
    log(...args: unknown[]): void;
  }
}
