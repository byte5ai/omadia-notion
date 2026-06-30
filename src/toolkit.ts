import { z } from 'zod';
import type { Client } from './client.js';
import type { EmbeddingClient, IndexResult } from './indexer.js';
import type { SearchHit, VectorStore } from './vectorStore.js';

/**
 * Toolkit = capability → executable handler with a Zod input schema.
 * Each entry mirrors 1:1 a capability in manifest.yaml. The runtime bridges
 * these ToolDescriptors into DomainTools; this package builds no LLM client
 * and runs no tool loop of its own.
 */

export interface ToolkitOptions {
  client: Client;
  embedder: EmbeddingClient;
  store: VectorStore;
  /** Locked, in-flight-coalescing reindex provided by the plugin so the tool
   *  and the cron can never write the index concurrently. */
  reindex: (maxPages?: number) => Promise<IndexResult>;
  log: (...args: unknown[]) => void;
}

export interface ToolDescriptor<I, O> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  run(input: I): Promise<O>;
}

export interface Toolkit {
  readonly tools: readonly ToolDescriptor<unknown, unknown>[];
  close(): Promise<void>;
}

const semanticSearchInput = z.object({
  query: z.string().min(1).max(1000),
  top_k: z.number().int().min(1).max(20).optional(),
});

const readPageInput = z.object({
  page_id: z.string().min(1),
});

const reindexInput = z.object({
  max_pages: z.number().int().min(1).max(1000).optional(),
});

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const semanticSearch: ToolDescriptor<z.infer<typeof semanticSearchInput>, SearchHit[]> = {
    id: 'notion_semantic_search',
    description:
      'Finds the most relevant sections in the indexed Notion workspace by embedding similarity.',
    input: semanticSearchInput,
    async run({ query, top_k }) {
      opts.log('tool:notion_semantic_search', { query, top_k });
      const queryEmbedding = await opts.embedder.embed(query);
      return opts.store.search(queryEmbedding, top_k ?? 6);
    },
  };

  const readPage: ToolDescriptor<
    z.infer<typeof readPageInput>,
    { pageId: string; markdown: string; truncated: boolean }
  > = {
    id: 'read_notion_page',
    description: 'Loads the full content of a Notion page as Markdown.',
    input: readPageInput,
    async run({ page_id }) {
      opts.log('tool:read_notion_page', { page_id });
      const { markdown, truncated } = await opts.client.pageMarkdown(page_id);
      return { pageId: page_id, markdown, truncated };
    },
  };

  const reindex: ToolDescriptor<z.infer<typeof reindexInput>, IndexResult> = {
    id: 'reindex_notion',
    description:
      'Crawls the workspace and updates the embedding index incrementally.',
    input: reindexInput,
    async run({ max_pages }) {
      opts.log('tool:reindex_notion', { max_pages });
      return opts.reindex(max_pages);
    },
  };

  // Dynamic setup-options provider (omadia post-install picker): returns the
  // top-level Notion pages the integration can see, as selectable roots for
  // `notion_root_ids`. Tagged via the manifest field's `options_provider`.
  const listRootsInput = z.object({}).passthrough();
  const listRoots: ToolDescriptor<
    z.infer<typeof listRootsInput>,
    Array<{ value: string; label: string; group?: string }>
  > = {
    id: 'list_notion_roots',
    description:
      'Lists the top-level Notion pages that can be selected as index roots.',
    input: listRootsInput,
    async run() {
      opts.log('tool:list_notion_roots');
      const { pages } = await opts.client.listAllPages({ maxPages: 500 });
      return pages
        .filter((p) => p.parent?.type === 'workspace')
        .map((p) => ({ value: p.id, label: p.title, group: 'Page' }));
    },
  };

  const tools = [
    semanticSearch,
    readPage,
    reindex,
    listRoots,
  ] as unknown as readonly ToolDescriptor<unknown, unknown>[];

  return {
    tools,
    async close() {
      await opts.client.dispose();
    },
  };
}
