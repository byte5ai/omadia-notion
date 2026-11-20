# omadia-notion

**Notion integration** for [omadia](https://omadia.ai) — semantic search over
a Notion workspace, packaged as a standalone, signable plugin ZIP.

## Why an embedding index (and not just Notion search)

Notion's REST API `POST /v1/search` matches **page/database titles only** —
there is no full-text or semantic search endpoint. To find content *by
meaning*, this plugin builds and maintains its **own** embedding index:

```
cron job ──> /v1/search (enumerate pages, paginated)
         ──> GET /v1/pages/{id}/markdown (one call per page)
         ──> chunk markdown ──> embed each chunk (kernel embeddingClient)
         ──> JSON vector store in plugin memory
notion_semantic_search ──> embed query ──> cosine-rank chunks locally
```

## Tools

| Tool | What it does |
|------|--------------|
| `notion_semantic_search` | Embeds the query, cosine-ranks the indexed chunks, returns the top page sections. Primary content-discovery path. |
| `read_notion_page` | Fetches a page as Markdown (live), following Notion's `truncated`/`unknown_block_ids` for large pages. |
| `reindex_notion` | Incremental crawl: re-embeds only pages whose `last_edited_time` changed; drops pages removed from the workspace. |

## Plugin boundary (spec 2042)

A plugin has no persona and no model loop. The tools are registered with
`ctx.tools.register` (`src/registerTools.ts`) and offered by the kernel to the
agents an operator granted this integration to; each tool declares
`capabilities[].side_effects` in the manifest. The former Notion-expert persona
ships as two inactive agent templates (en/de, `agent_templates:` in
`manifest.yaml`) that an operator turns into an agent in the Agent Builder.
Requires omadia core `>=1.75.0`. `embeddingClient@^1` stays allowed; all
network traffic uses `ctx.http.fetch` (`api.notion.com`).

## Setup (operator)

1. Create an internal integration at <https://www.notion.so/my-integrations>
   and copy its token.
2. **Share** the pages/databases you want searchable *with that integration*
   in Notion — the API only sees shared content.
3. Install this plugin, paste the token into **Notion API Token**.
4. Trigger `reindex_notion` once for the initial crawl (or wait for the cron).

Requires `@omadia/embeddings` (provides the `embeddingClient` service) and
`@omadia/memory`. The capability resolver activates both before this plugin;
without `embeddingClient` the plugin refuses to start.

## Develop

```bash
nvm use            # Node 22
npm install
npm run typecheck  # tsc gate (no emit)
npm run build      # esbuild bundle → out/omadia-integration-notion-0.2.0.zip
```

`src/plugin.ts` is the entry; esbuild bundles all local modules into
`dist/plugin.js`. Host-provided peers (`@omadia/plugin-api`, `zod`, `express`)
are kept external — `zod` in particular must NOT be bundled, or the host's
zod→tool-schema bridge breaks on a second zod instance.

`@omadia/plugin-api` is not on npm; `types/omadia-plugin-api.d.ts` provides
ambient stubs so the plugin compiles offline. The host injects the real
implementations at runtime.

Upload the resulting ZIP through the omadia admin UI's plugin store.

## Contracts

- `requires: ["embeddingClient@^1"]` → `ctx.services.get('embeddingClient')`
- `requires: ["memoryStore@^1"]` → `ctx.memory` backs the index. Resolves to
  EITHER `@omadia/memory` (filesystem) or `@omadia/memory-postgres` (Postgres) —
  it depends on the capability, not a specific provider id.
- `permissions.network.outbound: ["api.notion.com"]` → `ctx.http.fetch`
- Pins `Notion-Version: 2026-03-11` (page-markdown endpoint + data sources).

## Storage

The index uses a `VectorStore` interface with two implementations, chosen at
activation by what the deployment provides:

- **pgvector (preferred).** When the shared `graphPool` service is available
  (Postgres deployments — i.e. `@omadia/knowledge-graph-neon` +
  `@omadia/memory-postgres`), embeddings live in a native `vector` column and
  ranking is `ORDER BY embedding <=> $query` **in the database** (exact KNN).
  Tables: `notion_pages` + `notion_chunks` + `notion_index_meta`, scoped by
  `agent_id`. No JSON-float bloat, no loading the index into JS, granular
  per-page upserts. For very large corpora pin the vector dimension and add an
  hnsw index — the column is dimension-free today for model flexibility.
- **Sharded memory (fallback).** Filesystem/in-memory deployments (no
  `graphPool`) use `ctx.memory`: a small `pages.json` manifest + one
  `pages/<pageId>.json` shard per page; reindex writes only changed pages,
  search reads shards once into an in-memory cache. Here the embedding vector
  dominates file size (~11 KB/chunk as JSON) — fine for a few hundred pages.

## Scaling notes

- Notion rate-limits ~3 req/s; the plugin HTTP accessor caps **60 req/min**
  (the tighter bound). The client paces itself and honours `Retry-After`;
  `crawl_max_pages` bounds a single run, so very large workspaces fill in over
  several cron ticks.
- Embeddings from different models are incomparable — the store tags itself
  with a model label and self-clears if it changes.

## Privacy & the LLM boundary

omadia ships a Privacy Shield (v4) that, by default (`_privacy_mode: guarded`),
**interns every tool result server-side and hands the LLM only an identity-free
digest** — raw tool output never reaches the model. That protection is
automatic; this plugin does not (and should not) call it itself.

The catch for a document-RAG plugin: the shield is built for row/dataset-shaped
results. The content this plugin returns — prose snippets from
`notion_semantic_search` and full pages from `read_notion_page` — is exactly the
"document-shaped" case the shield cannot usefully summarise. Under `guarded`,
the model would receive a digest instead of the page text, which defeats the
plugin's purpose.

To make the plugin answer from real content, the operator must set
`_privacy_mode` on this plugin (in the post-install config editor) to either:

- **`bypass`** — all of this plugin's tool output reaches the LLM (a
  transparency entry is recorded in the run receipt for every call), or
- **`per_tool`** with `_privacy_bypass_scopes` = `notion_semantic_search,
  read_notion_page` — bypass only the content-returning tools; everything else
  stays guarded.

This is a deliberate data-governance decision: Notion page content (including
any PII it contains) will then be sent to the configured LLM. Choose the LLM
provider accordingly (a local/EU-hosted model for sensitive workspaces).

Two paths the shield does **not** cover:

- **Embeddings.** Indexing sends raw page text to the configured
  `embeddingClient`. With the default local `@omadia/embeddings` (Ollama) this
  stays in-tenant; a cloud embeddings provider means content leaves your box.
- **The local index.** Chunks + embeddings are stored unencrypted in this
  plugin's memory scope (at rest, inside your deployment).

## License

[MIT](LICENSE) — Copyright (c) 2026 byte5 GmbH
