/**
 * Notion integration — Notion REST client
 *
 * Pure business logic against the Notion REST API. No LLM/Zod code here
 * (that lives in toolkit.ts). All egress goes through the injected
 * `fetchImpl` (ctx.http.fetch) so the kernel's outbound allow-list + SSRF
 * guard apply.
 *
 * Notion specifics handled here:
 *   - `Notion-Version: 2026-03-11` header (data-sources model + page markdown).
 *   - `/v1/search` matches TITLES only — used to enumerate pages, NOT to find
 *     content by meaning (that's the embedding index's job). Sorted newest-
 *     edited first so a capped crawl always refreshes the freshest pages.
 *   - `GET /v1/pages/{id}/markdown` returns ready-to-chunk Markdown in one
 *     call; `truncated`/`unknown_block_ids` are followed up automatically.
 *   - Parent lookups (`getPageParent`, …) power the scope filter's ancestry
 *     walk so an operator can restrict indexing to chosen pages/databases.
 *   - Rate limit: ~3 req/s per connection; 429 carries `Retry-After`. We pace
 *     conservatively because the plugin HTTP accessor also caps 60 req/min.
 */

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const MIN_REQUEST_INTERVAL_MS = 400; // ~2.5 req/s, under Notion's 3 req/s
const MAX_RETRIES = 4;
const MAX_TRUNCATION_FOLLOWUPS = 50; // bound the fan-out on giant pages

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  fetchImpl: FetchImpl;
  token: string;
  timeoutMs: number;
  log: (...args: unknown[]) => void;
}

/** Notion `parent` discriminated union (the subset we walk). */
export type NotionParent =
  | { readonly type: 'page_id'; readonly page_id: string }
  | { readonly type: 'block_id'; readonly block_id: string }
  | { readonly type: 'database_id'; readonly database_id: string }
  | { readonly type: 'data_source_id'; readonly data_source_id: string }
  | { readonly type: 'workspace'; readonly workspace: true };

export interface NotionPageRef {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly lastEdited: string;
  readonly parent: NotionParent | null;
}

export interface PageMarkdown {
  readonly markdown: string;
  readonly truncated: boolean;
}

export interface PageListing {
  readonly pages: NotionPageRef[];
  /** True when the crawl stopped at `maxPages` while more pages remained —
   *  the listing is then a PREFIX, not the whole workspace. */
  readonly truncated: boolean;
}

export interface Client {
  /** Self-test: cheap GET that validates the token. */
  ping(): Promise<void>;
  /** Enumerate pages the integration can see, newest-edited first. */
  listAllPages(opts: { maxPages: number; signal?: AbortSignal }): Promise<PageListing>;
  /** Fetch a page rendered as Markdown, following truncation. */
  pageMarkdown(pageId: string, signal?: AbortSignal): Promise<PageMarkdown>;
  /** Parent of a page / block / data source / database, or null on error.
   *  Used by the scope filter; failures degrade to "no parent" (stops the walk). */
  getPageParent(id: string, signal?: AbortSignal): Promise<NotionParent | null>;
  getBlockParent(id: string, signal?: AbortSignal): Promise<NotionParent | null>;
  getDataSourceParent(id: string, signal?: AbortSignal): Promise<NotionParent | null>;
  getDatabaseParent(id: string, signal?: AbortSignal): Promise<NotionParent | null>;
  dispose(): Promise<void>;
}

interface NotionRichText {
  readonly plain_text?: string;
}

interface NotionProperty {
  readonly type?: string;
  readonly title?: NotionRichText[];
}

interface NotionSearchResult {
  readonly id: string;
  readonly object: string;
  readonly url?: string;
  readonly last_edited_time?: string;
  readonly archived?: boolean;
  readonly in_trash?: boolean;
  readonly parent?: NotionParent;
  readonly properties?: Record<string, NotionProperty>;
}

interface NotionSearchResponse {
  readonly results: NotionSearchResult[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;
}

interface NotionMarkdownResponse {
  readonly page_markdown?: string;
  readonly markdown?: string;
  readonly truncated?: boolean;
  readonly unknown_block_ids?: string[];
}

interface NotionNodeWithParent {
  readonly parent?: NotionParent;
}

function extractTitle(result: NotionSearchResult): string {
  const props = result.properties ?? {};
  for (const prop of Object.values(props)) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text ?? '').join('').trim();
      if (text) return text;
    }
  }
  return 'Untitled';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        rejectSleep(new Error('aborted'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function createClient(opts: ClientOptions): Client {
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    'Notion-Version': NOTION_VERSION,
    Accept: 'application/json',
  };

  let lastRequestAt = 0;

  async function pace(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const wait = MIN_REQUEST_INTERVAL_MS - (now - lastRequestAt);
    if (wait > 0) await sleep(wait, signal);
    lastRequestAt = Date.now();
  }

  async function request<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await pace(signal);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      const onOuterAbort = (): void => controller.abort();
      if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const res = await opts.fetchImpl(`${NOTION_BASE}${path}`, {
          ...init,
          headers: { ...baseHeaders, ...((init.headers as Record<string, string>) ?? {}) },
          signal: controller.signal,
        });

        if (res.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
          opts.log('notion: 429 rate-limited, backing off', { retryAfter });
          await sleep(Math.max(1, retryAfter) * 1000, signal);
          continue;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(
            `notion: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
          );
        }

        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  async function parentOf(path: string, signal?: AbortSignal): Promise<NotionParent | null> {
    try {
      const node = await request<NotionNodeWithParent>(path, { method: 'GET' }, signal);
      return node.parent ?? null;
    } catch (err) {
      opts.log('notion: parent lookup failed', { path, err: String(err) });
      return null;
    }
  }

  return {
    async ping() {
      await request<unknown>('/users/me', { method: 'GET' });
    },

    async listAllPages({ maxPages, signal }) {
      const pages: NotionPageRef[] = [];
      let cursor: string | null = null;
      let truncated = false;

      while (pages.length < maxPages) {
        const body: Record<string, unknown> = {
          filter: { value: 'page', property: 'object' },
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          page_size: 100,
        };
        if (cursor) body.start_cursor = cursor;

        const resp = await request<NotionSearchResponse>(
          '/search',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          signal,
        );

        for (const result of resp.results) {
          if (result.object !== 'page') continue;
          if (result.archived === true || result.in_trash === true) continue;
          if (pages.length >= maxPages) {
            truncated = true;
            break;
          }
          pages.push({
            id: result.id,
            title: extractTitle(result),
            url: result.url ?? '',
            lastEdited: result.last_edited_time ?? '',
            parent: result.parent ?? null,
          });
        }

        if (truncated) break;
        if (!resp.has_more || !resp.next_cursor) break;
        cursor = resp.next_cursor;
        if (pages.length >= maxPages && resp.has_more) truncated = true;
      }

      return { pages, truncated };
    },

    async pageMarkdown(pageId, signal) {
      const first = await request<NotionMarkdownResponse>(
        `/pages/${pageId}/markdown`,
        { method: 'GET' },
        signal,
      );
      let markdown = first.page_markdown ?? first.markdown ?? '';
      const truncated = first.truncated === true;

      // Large pages (~20k+ blocks) come back truncated with the missing block
      // ids; re-fetch those and append. Bounded by MAX_TRUNCATION_FOLLOWUPS so
      // a pathological page can't blow the request budget.
      if (truncated && Array.isArray(first.unknown_block_ids)) {
        const ids = first.unknown_block_ids.slice(0, MAX_TRUNCATION_FOLLOWUPS);
        for (const blockId of ids) {
          if (signal?.aborted) break;
          try {
            const more = await request<NotionMarkdownResponse>(
              `/pages/${blockId}/markdown`,
              { method: 'GET' },
              signal,
            );
            const extra = more.page_markdown ?? more.markdown ?? '';
            if (extra) markdown += `\n\n${extra}`;
          } catch (err) {
            opts.log('notion: truncation follow-up failed', { blockId, err: String(err) });
          }
        }
      }

      return { markdown, truncated };
    },

    getPageParent: (id, signal) => parentOf(`/pages/${id}`, signal),
    getBlockParent: (id, signal) => parentOf(`/blocks/${id}`, signal),
    getDataSourceParent: (id, signal) => parentOf(`/data_sources/${id}`, signal),
    getDatabaseParent: (id, signal) => parentOf(`/databases/${id}`, signal),

    async dispose() {
      // No persistent sockets to close — fetchImpl is kernel-owned.
    },
  };
}
