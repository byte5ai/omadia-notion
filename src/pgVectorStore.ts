/**
 * pgvector-backed vector store — the real thing when Postgres is available.
 *
 * Uses the shared `graphPool` (a `pg.Pool` published by
 * @omadia/knowledge-graph-neon) to store embeddings in a native `vector`
 * column and rank by cosine distance (`<=>`) IN THE DATABASE — no JSON blobs,
 * no loading the whole index into JS. Rows are scoped by `agent_id` so several
 * installs can share the tables.
 *
 * Schema (created lazily, idempotent):
 *   notion_pages (agent_id, page_id, last_edited, parent jsonb, chunk_count)
 *   notion_chunks(agent_id, page_id, chunk_index, content, embedding vector)
 *   notion_index_meta(agent_id, model)  — clears an agent's rows on model change
 *
 * The `embedding vector` column is left dimension-free, so any embedding model
 * works and search is an exact KNN scan (`ORDER BY embedding <=> $q`). For very
 * large corpora, pin the dimension and add an hnsw index — see README.
 */

import type { Pool } from 'pg';

import type { NotionParent } from './client.js';
import {
  notionUrl,
  type ChunkBody,
  type PageMeta,
  type SearchHit,
  type VectorStore,
} from './vectorStore.js';

/** pgvector text literal for a vector: `[v1,v2,…]`. */
function vectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(',')}]`;
}

export function createPgVectorStore(opts: {
  pool: Pool;
  agentId: string;
  model: string;
  log: (...args: unknown[]) => void;
}): VectorStore {
  const { pool, agentId, model, log } = opts;
  let ready: Promise<void> | null = null;

  async function ensureSchema(): Promise<void> {
    if (ready) return ready;
    ready = (async (): Promise<void> => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(
        `CREATE TABLE IF NOT EXISTS notion_pages (
           agent_id    text    NOT NULL,
           page_id     text    NOT NULL,
           last_edited text    NOT NULL,
           parent      jsonb,
           chunk_count integer NOT NULL,
           PRIMARY KEY (agent_id, page_id)
         )`,
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS notion_chunks (
           agent_id    text    NOT NULL,
           page_id     text    NOT NULL,
           chunk_index integer NOT NULL,
           content     text    NOT NULL,
           embedding   vector  NOT NULL,
           PRIMARY KEY (agent_id, page_id, chunk_index)
         )`,
      );
      await pool.query(
        'CREATE INDEX IF NOT EXISTS notion_chunks_agent_idx ON notion_chunks (agent_id)',
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS notion_index_meta (
           agent_id text PRIMARY KEY,
           model    text NOT NULL
         )`,
      );
      // Embedding vectors from different models are incomparable — clear this
      // agent's rows if the model changed since last activation.
      const prev = await pool.query<{ model: string }>(
        'SELECT model FROM notion_index_meta WHERE agent_id = $1',
        [agentId],
      );
      const prevModel = prev.rows[0]?.model;
      if (prevModel !== undefined && prevModel !== model) {
        log('notion-index(pg): embedding model changed — clearing agent rows', {
          prevModel,
          model,
        });
        await pool.query('DELETE FROM notion_chunks WHERE agent_id = $1', [agentId]);
        await pool.query('DELETE FROM notion_pages WHERE agent_id = $1', [agentId]);
      }
      await pool.query(
        `INSERT INTO notion_index_meta (agent_id, model) VALUES ($1, $2)
         ON CONFLICT (agent_id) DO UPDATE SET model = EXCLUDED.model`,
        [agentId, model],
      );
    })();
    return ready;
  }

  async function loadMeta(): Promise<Record<string, PageMeta>> {
    await ensureSchema();
    const res = await pool.query<{
      page_id: string;
      last_edited: string;
      parent: NotionParent | null;
      chunk_count: number;
    }>(
      'SELECT page_id, last_edited, parent, chunk_count FROM notion_pages WHERE agent_id = $1',
      [agentId],
    );
    const out: Record<string, PageMeta> = {};
    for (const r of res.rows) {
      out[r.page_id] = {
        lastEdited: r.last_edited,
        chunkCount: r.chunk_count,
        ...(r.parent !== null ? { parent: r.parent } : {}),
      };
    }
    return out;
  }

  async function saveMeta(pages: Record<string, PageMeta>): Promise<void> {
    await ensureSchema();
    const ids = Object.keys(pages);
    for (const [pageId, m] of Object.entries(pages)) {
      await pool.query(
        `INSERT INTO notion_pages (agent_id, page_id, last_edited, parent, chunk_count)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_id, page_id) DO UPDATE SET
           last_edited = EXCLUDED.last_edited,
           parent      = EXCLUDED.parent,
           chunk_count = EXCLUDED.chunk_count`,
        [
          agentId,
          pageId,
          m.lastEdited,
          m.parent === undefined || m.parent === null ? null : JSON.stringify(m.parent),
          m.chunkCount,
        ],
      );
    }
    // Reconcile: drop pages (and their chunks) no longer present.
    if (ids.length > 0) {
      await pool.query(
        'DELETE FROM notion_chunks WHERE agent_id = $1 AND NOT (page_id = ANY($2))',
        [agentId, ids],
      );
      await pool.query(
        'DELETE FROM notion_pages WHERE agent_id = $1 AND NOT (page_id = ANY($2))',
        [agentId, ids],
      );
    } else {
      await pool.query('DELETE FROM notion_chunks WHERE agent_id = $1', [agentId]);
      await pool.query('DELETE FROM notion_pages WHERE agent_id = $1', [agentId]);
    }
  }

  async function writePage(pageId: string, chunks: readonly ChunkBody[]): Promise<void> {
    await ensureSchema();
    await pool.query('DELETE FROM notion_chunks WHERE agent_id = $1 AND page_id = $2', [
      agentId,
      pageId,
    ]);
    let i = 0;
    for (const c of chunks) {
      await pool.query(
        `INSERT INTO notion_chunks (agent_id, page_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [agentId, pageId, i++, c.text, vectorLiteral(c.embedding)],
      );
    }
  }

  async function deletePage(pageId: string): Promise<void> {
    await ensureSchema();
    await pool.query('DELETE FROM notion_chunks WHERE agent_id = $1 AND page_id = $2', [
      agentId,
      pageId,
    ]);
    await pool.query('DELETE FROM notion_pages WHERE agent_id = $1 AND page_id = $2', [
      agentId,
      pageId,
    ]);
  }

  async function search(queryEmbedding: number[], topK: number): Promise<SearchHit[]> {
    await ensureSchema();
    const res = await pool.query<{ page_id: string; content: string; dist: number }>(
      `SELECT page_id, content, (embedding <=> $2::vector) AS dist
       FROM notion_chunks
       WHERE agent_id = $1
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [agentId, vectorLiteral(queryEmbedding), topK],
    );
    return res.rows.map((r) => ({
      pageId: r.page_id,
      url: notionUrl(r.page_id),
      snippet: r.content.length > 600 ? `${r.content.slice(0, 600)}…` : r.content,
      // `<=>` is cosine DISTANCE; similarity score = 1 - distance.
      score: Number((1 - Number(r.dist)).toFixed(4)),
    }));
  }

  async function stats(): Promise<{ pages: number; chunks: number }> {
    await ensureSchema();
    const p = await pool.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM notion_pages WHERE agent_id = $1',
      [agentId],
    );
    const ch = await pool.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM notion_chunks WHERE agent_id = $1',
      [agentId],
    );
    return { pages: Number(p.rows[0]?.c ?? 0), chunks: Number(ch.rows[0]?.c ?? 0) };
  }

  return { loadMeta, saveMeta, writePage, deletePage, search, stats };
}
