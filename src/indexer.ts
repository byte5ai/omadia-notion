/**
 * Crawl → scope-filter → chunk → embed → store, sharded per page.
 *
 * Incremental + DB-friendly: a page's shard is (re)written only when its
 * `last_edited_time` is newer than what we stored; unchanged pages are left
 * untouched (no read, no write); pages that are deleted/unshared in Notion or
 * fall outside the current scope are explicitly removed via `deletePage`. This
 * keeps writes granular — one modest row per changed page — so a Postgres-
 * backed memory store never rewrites a single giant blob.
 *
 * Deletion reconciliation: "not seen this crawl = deleted" only holds for a
 * COMPLETE crawl. On an incomplete crawl (capped by maxPages or aborted) we
 * keep pages we didn't visit — UNLESS they're now out of scope (re-evaluated
 * from the stored parent), so a narrowed scope still prunes orphaned content.
 * Pages we DID enumerate but excluded are dropped either way.
 *
 * Runs inside the cron job and the `reindex_notion` tool, never in activate()
 * (a full crawl exceeds the 10s budget). Respects the AbortSignal.
 */

import { chunkMarkdown } from './chunker.js';
import type { Client, NotionPageRef } from './client.js';
import type { ScopeFilter } from './scope.js';
import type { ChunkBody, PageMeta, VectorStore } from './vectorStore.js';

/** Minimal mirror of the kernel `embeddingClient` service (provided by
 *  `@omadia/embeddings`, consumed via ctx.services.get('embeddingClient')). */
export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export interface IndexResult {
  pagesIndexed: number;
  pagesSkipped: number;
  pagesRemoved: number;
  chunks: number;
  durationMs: number;
}

export async function crawlAndIndex(opts: {
  client: Client;
  embedder: EmbeddingClient;
  store: VectorStore;
  scope: ScopeFilter;
  chunkSize: number;
  maxPages: number;
  signal: AbortSignal;
  log: (...args: unknown[]) => void;
  now: number;
}): Promise<IndexResult> {
  const { client, embedder, store, scope, chunkSize, maxPages, signal, log, now } = opts;

  const meta = await store.loadMeta();
  const { pages, truncated } = await client.listAllPages({ maxPages, signal });

  // Every page id enumerated this run (before scope filtering) — distinguishes
  // "saw it but excluded/deleted" from "never visited (beyond cap)".
  const enumerated = new Set<string>(pages.map((p) => p.id));

  let pagesIndexed = 0;
  let pagesSkipped = 0;
  const nextMeta: Record<string, PageMeta> = {};

  for (const page of pages) {
    if (signal.aborted) break;
    if (!(await scope.included(page))) continue;

    const prev = meta[page.id];
    // Skip when Notion's lastEdited is not newer than the stored value. A
    // failed embed leaves no `prev` (see catch), so it retries next run.
    if (prev && page.lastEdited <= prev.lastEdited) {
      nextMeta[page.id] = { ...prev, parent: page.parent };
      pagesSkipped++;
      continue;
    }

    try {
      const { markdown } = await client.pageMarkdown(page.id, signal);
      const pieces = chunkMarkdown(markdown, chunkSize);
      const chunks: ChunkBody[] = [];
      for (const text of pieces) {
        if (signal.aborted) break;
        // The title is prepended only to enrich the EMBEDDING; it is not stored.
        const embedding = await embedder.embed(`${page.title}\n\n${text}`);
        chunks.push({ text, embedding });
      }
      if (chunks.length > 0) await store.writePage(page.id, chunks);
      else await store.deletePage(page.id); // empty page → no shard row
      nextMeta[page.id] = {
        lastEdited: page.lastEdited,
        chunkCount: chunks.length,
        parent: page.parent,
      };
      pagesIndexed++;
    } catch (err) {
      log('notion-index: page failed', { pageId: page.id, err: String(err) });
      // Keep the previously-indexed shard if there was one; a brand-new page
      // that fails is simply not recorded, so it retries on the next run.
      if (prev) nextMeta[page.id] = { ...prev, parent: page.parent };
    }
  }

  // Reconcile stored pages we didn't (re)write above, and delete their shards.
  const complete = !truncated && !signal.aborted;
  const removed: string[] = [];
  for (const [id, m] of Object.entries(meta)) {
    if (nextMeta[id]) continue; // handled this run
    if (enumerated.has(id)) {
      removed.push(id); // enumerated but excluded/failed-without-prev → drop
      continue;
    }
    if (complete) {
      removed.push(id); // absent from a full crawl → deleted/unshared → drop
      continue;
    }
    // Incomplete crawl: page not visited (beyond cap / aborted). Keep it only
    // if it is still in scope under the CURRENT config (re-evaluated from the
    // stored parent), so a narrowed scope prunes orphaned content too. Legacy
    // entries without a stored parent can't be re-scoped → keep (a full crawl
    // prunes later).
    if (m.parent !== undefined) {
      // Scope only reads id + parent; title/url are unused here.
      const ref: NotionPageRef = {
        id,
        title: '',
        url: '',
        lastEdited: m.lastEdited,
        parent: m.parent,
      };
      if (!(await scope.included(ref))) {
        removed.push(id);
        continue;
      }
    }
    nextMeta[id] = m; // carry over (shard untouched)
  }

  for (const id of removed) await store.deletePage(id);
  await store.saveMeta(nextMeta);

  let chunks = 0;
  for (const m of Object.values(nextMeta)) chunks += m.chunkCount;

  return {
    pagesIndexed,
    pagesSkipped,
    pagesRemoved: removed.length,
    chunks,
    durationMs: Date.now() - now,
  };
}
