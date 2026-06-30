import type { Pool } from 'pg';

import { createClient } from './client.js';
import { crawlAndIndex, type EmbeddingClient, type IndexResult } from './indexer.js';
import { createPgVectorStore } from './pgVectorStore.js';
import { createScopeFilter, parseIdList } from './scope.js';
import { createToolkit, type Toolkit } from './toolkit.js';
import type { PluginContext } from '@omadia/plugin-api';
import { createVectorStore, type VectorStore } from './vectorStore.js';

export const PLUGIN_ID = '@omadia/integration-notion' as const;

const DEFAULT_REINDEX_CRON = '0 */6 * * *';
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_TIMEOUT_MS = 20_000;
const REINDEX_JOB_TIMEOUT_MS = 120_000;
// Vectors are only comparable within one embedding model. The kernel
// `embeddingClient` doesn't expose its model name, so we tag the index with
// a stable label; bumping it forces a clean re-index after a model swap.
const EMBEDDING_INDEX_MODEL = 'kernel-embeddingClient-v1';

export interface AgentHandle {
  readonly toolkit: Toolkit;
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<AgentHandle> {
  ctx.log('activating');

  if (!ctx.http) {
    throw new Error(
      'notion: ctx.http missing — manifest must declare permissions.network.outbound (api.notion.com)',
    );
  }

  const embedder = ctx.services.get<EmbeddingClient>('embeddingClient');
  if (!embedder) {
    throw new Error(
      "notion: 'embeddingClient' service unavailable — install/configure @omadia/embeddings (manifest requires embeddingClient@^1)",
    );
  }

  const token = await ctx.secrets.require('notion_api_token');
  const timeoutMs = ctx.config.get<number>('request_timeout_ms') ?? DEFAULT_TIMEOUT_MS;
  const chunkSize = ctx.config.get<number>('chunk_size') ?? DEFAULT_CHUNK_SIZE;
  const maxPages = ctx.config.get<number>('crawl_max_pages') ?? DEFAULT_MAX_PAGES;
  const cron = ctx.config.get<string>('reindex_cron') ?? DEFAULT_REINDEX_CRON;
  const rootIds = parseIdList(ctx.config.get<string>('notion_root_ids'));
  const excludeIds = parseIdList(ctx.config.get<string>('notion_exclude_ids'));

  const httpFetch = ctx.http.fetch.bind(ctx.http);
  const client = createClient({ fetchImpl: httpFetch, token, timeoutMs, log: ctx.log });

  // Self-test: one cheap GET. NOT a crawl (10s activate budget).
  await client.ping();
  ctx.log('self-test ok', { rootIds: rootIds.length, excludeIds: excludeIds.length });

  // Prefer a real pgvector store when Postgres is available (the shared
  // `graphPool` from @omadia/knowledge-graph-neon, transitively up whenever
  // memoryStore resolves to @omadia/memory-postgres). Otherwise fall back to
  // the sharded memory store (filesystem deployments).
  const pgPool = ctx.services.get<Pool>('graphPool');
  let store: VectorStore;
  if (pgPool) {
    store = createPgVectorStore({
      pool: pgPool,
      agentId: ctx.agentId,
      model: EMBEDDING_INDEX_MODEL,
      log: ctx.log,
    });
    ctx.log('vector store: pgvector (graphPool)');
  } else if (ctx.memory) {
    store = createVectorStore({ memory: ctx.memory, model: EMBEDDING_INDEX_MODEL, log: ctx.log });
    ctx.log('vector store: sharded memory (no graphPool)');
  } else {
    throw new Error(
      'notion: no vector store available — need either graphPool (Postgres) or ctx.memory (memoryStore@1)',
    );
  }

  const refreshStatus = async (): Promise<void> => {
    const { pages, chunks } = await store.stats();
    if (chunks === 0) {
      ctx.status.report({
        state: 'needs_action',
        title: 'Index empty',
        detail: 'Workspace not indexed yet — run "reindex_notion" or wait for the cron.',
      });
    } else {
      ctx.status.report({
        state: 'ok',
        title: 'Indexed',
        detail: `${pages} pages, ${chunks} chunks${rootIds.length ? ` (restricted to ${rootIds.length} root(s))` : ''}.`,
      });
    }
  };

  // Single in-flight index run. The cron tick and the manual `reindex_notion`
  // tool both go through here, so they can never write notion-index.json
  // concurrently — a second caller awaits the run already in progress.
  let inFlight: Promise<IndexResult> | null = null;
  const runIndex = (maxPagesOverride?: number, signal?: AbortSignal): Promise<IndexResult> => {
    if (inFlight) {
      ctx.log('reindex: a run is already in flight, coalescing');
      return inFlight;
    }
    const controller = signal ? null : new AbortController();
    const effectiveSignal = signal ?? controller!.signal;
    inFlight = crawlAndIndex({
      client,
      embedder,
      store,
      scope: createScopeFilter({ client, rootIds, excludeIds, signal: effectiveSignal, log: ctx.log }),
      chunkSize,
      maxPages: maxPagesOverride ?? maxPages,
      signal: effectiveSignal,
      log: ctx.log,
      now: Date.now(),
    })
      .then(async (result) => {
        ctx.log('reindex done', result);
        await refreshStatus();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const toolkit = createToolkit({
    client,
    embedder,
    store,
    reindex: (mp) => runIndex(mp),
    log: ctx.log,
  });

  const disposeJob = ctx.jobs.register(
    { name: 'notion-reindex', schedule: { cron }, timeoutMs: REINDEX_JOB_TIMEOUT_MS, overlap: 'skip' },
    (signal) => runIndex(undefined, signal).then(() => undefined),
  );

  await refreshStatus();
  ctx.log('ready');

  return {
    toolkit,
    async close() {
      ctx.log('deactivating');
      disposeJob();
      await toolkit.close();
    },
  };
}

export default { PLUGIN_ID, activate };
