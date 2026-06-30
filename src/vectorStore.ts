/**
 * Sharded vector store over the per-plugin memory accessor.
 *
 * `ctx.memory` is an ABSTRACTION — it can be filesystem-backed
 * (@omadia/memory's FilesystemMemoryStore) OR Postgres-backed
 * (PostgresMemoryStore, one row per file in `memory_files`). To respect a
 * DB-backed store we do NOT keep one giant blob (that becomes a single huge
 * row, fully rewritten on every reindex). Instead the index is sharded:
 *
 *   pages.json            → { version, model, pages: { [pageId]: PageMeta } }
 *                           small manifest (one modest row); drives incremental
 *                           updates + scope pruning without reading shards.
 *   pages/<pageId>.json   → ChunkBody[] for that page (text + embedding).
 *                           one modest row PER PAGE — reindex writes only the
 *                           pages that changed and deletes removed ones.
 *
 * Search needs every chunk, so on first query we read all shards once and hold
 * them in an in-memory cache (invalidated on any write). Per-query cost is then
 * just the cosine scan, not N row reads.
 *
 * The embedding vector dominates size (768 floats); base64-Float32 or pgvector
 * is the lever for further shrinkage (see README "Scaling").
 */

import type { MemoryAccessor } from '@omadia/plugin-api';

import type { NotionParent } from './client.js';

const META_FILE = 'pages.json';
const PAGES_DIR = 'pages';
// v2: lean, sharded schema. Bumping discards any incompatible prior manifest.
const INDEX_VERSION = 2;

/** A page's chunk as stored in its shard (pageId comes from the shard path). */
export interface ChunkBody {
  readonly text: string;
  readonly embedding: number[];
}

export interface PageMeta {
  readonly lastEdited: string;
  readonly chunkCount: number;
  /** Notion parent pointer — lets the indexer re-evaluate scope for a stored
   *  page without re-fetching it. Absent on legacy entries. */
  readonly parent?: NotionParent | null;
}

interface MetaFile {
  version: number;
  model: string;
  pages: Record<string, PageMeta>;
}

export interface SearchHit {
  readonly pageId: string;
  /** Derived from the page id (notion.so/<id>) — not stored. */
  readonly url: string;
  readonly snippet: string;
  readonly score: number;
}

/** Notion page URL from a page id (works dashed or bare). */
export function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface VectorStore {
  /** Read the page manifest (cheap — no shard reads). */
  loadMeta(): Promise<Record<string, PageMeta>>;
  /** Persist the page manifest. */
  saveMeta(pages: Record<string, PageMeta>): Promise<void>;
  /** Write one page's chunks (one shard row). */
  writePage(pageId: string, chunks: readonly ChunkBody[]): Promise<void>;
  /** Remove one page's shard. */
  deletePage(pageId: string): Promise<void>;
  /** Cosine-rank all indexed chunks against the query embedding. */
  search(queryEmbedding: number[], topK: number): Promise<SearchHit[]>;
  /** Coarse counts for the status badge (from the manifest, no shard reads). */
  stats(): Promise<{ pages: number; chunks: number }>;
}

export function createVectorStore(opts: {
  memory: MemoryAccessor;
  model: string;
  log: (...args: unknown[]) => void;
}): VectorStore {
  const { memory, model, log } = opts;
  const shardPath = (pageId: string): string => `${PAGES_DIR}/${pageId}.json`;

  // In-memory cache of all chunks for search. Built lazily, dropped on writes.
  let cache: Array<{ pageId: string; text: string; embedding: number[] }> | null = null;

  async function loadMeta(): Promise<Record<string, PageMeta>> {
    if (!(await memory.exists(META_FILE))) return {};
    try {
      const parsed = JSON.parse(await memory.readFile(META_FILE)) as Partial<MetaFile>;
      if (parsed.version !== INDEX_VERSION || parsed.model !== model) {
        // Schema or embedding-model changed — start fresh rather than mix
        // incomparable vectors. Old shards for absent pages become orphans
        // that are never read (not in the manifest); present pages get
        // overwritten as they are re-indexed.
        log('notion-index: incompatible manifest discarded', {
          haveVersion: parsed.version,
          haveModel: parsed.model,
        });
        return {};
      }
      return parsed.pages ?? {};
    } catch (err) {
      log('notion-index: manifest load failed, starting empty', { err: String(err) });
      return {};
    }
  }

  async function saveMeta(pages: Record<string, PageMeta>): Promise<void> {
    const file: MetaFile = { version: INDEX_VERSION, model, pages };
    await memory.writeFile(META_FILE, JSON.stringify(file));
    cache = null;
  }

  async function writePage(pageId: string, chunks: readonly ChunkBody[]): Promise<void> {
    await memory.writeFile(shardPath(pageId), JSON.stringify(chunks));
    cache = null;
  }

  async function deletePage(pageId: string): Promise<void> {
    const path = shardPath(pageId);
    if (await memory.exists(path)) await memory.delete(path);
    cache = null;
  }

  async function buildCache(): Promise<
    Array<{ pageId: string; text: string; embedding: number[] }>
  > {
    const meta = await loadMeta();
    const all: Array<{ pageId: string; text: string; embedding: number[] }> = [];
    for (const pageId of Object.keys(meta)) {
      const path = shardPath(pageId);
      try {
        if (!(await memory.exists(path))) continue;
        const chunks = JSON.parse(await memory.readFile(path)) as ChunkBody[];
        for (const c of chunks) {
          all.push({ pageId, text: c.text, embedding: c.embedding });
        }
      } catch (err) {
        log('notion-index: shard read failed (skipped)', { pageId, err: String(err) });
      }
    }
    return all;
  }

  async function search(queryEmbedding: number[], topK: number): Promise<SearchHit[]> {
    if (cache === null) cache = await buildCache();
    const scored = cache.map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, topK).map(({ chunk, score }) => ({
      pageId: chunk.pageId,
      url: notionUrl(chunk.pageId),
      snippet: chunk.text.length > 600 ? `${chunk.text.slice(0, 600)}…` : chunk.text,
      score: Number(score.toFixed(4)),
    }));
  }

  async function stats(): Promise<{ pages: number; chunks: number }> {
    const meta = await loadMeta();
    let chunks = 0;
    for (const m of Object.values(meta)) chunks += m.chunkCount;
    return { pages: Object.keys(meta).length, chunks };
  }

  return { loadMeta, saveMeta, writePage, deletePage, search, stats };
}
