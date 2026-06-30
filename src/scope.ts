/**
 * Scope filter — decides whether a page belongs in the index, given an
 * operator-configured allow-list (`notion_root_ids`) and deny-list
 * (`notion_exclude_ids`) of page / database / data-source ids.
 *
 * A page is IN scope when its ancestry (itself + every ancestor page,
 * database and data source up to the workspace root) intersects the roots;
 * it is OUT when the ancestry intersects the excludes. Empty roots = whole
 * shared workspace. This gives "index this page/teamspace and everything
 * under it" semantics on top of Notion's own sharing model.
 *
 * Notion's native access control (sharing pages with the integration) is the
 * primary scoping mechanism; this is a refinement when the integration has
 * broad access but only a subtree should be indexed.
 *
 * Ancestry is resolved by walking `parent` pointers via the client, with a
 * shared per-node cache so an ancestor is fetched at most once per crawl.
 * Block parents are traversed transparently; lookup failures stop the walk
 * (fail-open at that node) rather than throwing.
 */

import type { Client, NotionPageRef, NotionParent } from './client.js';

const MAX_ANCESTRY_DEPTH = 20;

/** Normalize any id form (dashed UUID, bare 32-hex, or a Notion URL ending in
 *  `-<32hex>`) to bare lowercase 32-hex for set comparison. */
export function normalizeNotionId(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length >= 32 ? hex.slice(-32) : hex;
}

/** Normalize a config value into a list of ids. Accepts the multiselect shape
 *  (a real `string[]` or a JSON-encoded `'["id",…]'`) and the legacy
 *  comma/whitespace-separated string, so old and new installs both work. */
export function parseIdList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  let parts: unknown[];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        parts = Array.isArray(parsed) ? parsed : [];
      } catch {
        parts = trimmed.split(/[\s,]+/);
      }
    } else {
      parts = trimmed.split(/[\s,]+/);
    }
  } else {
    return [];
  }
  return parts
    .map((s) => (typeof s === 'string' ? normalizeNotionId(s) : ''))
    .filter((s) => s.length === 32);
}

export interface ScopeFilter {
  /** Whether this page should be indexed. */
  included(page: NotionPageRef): Promise<boolean>;
  /** True when no roots/excludes are configured (everything is in scope). */
  readonly unrestricted: boolean;
}

export function createScopeFilter(opts: {
  client: Client;
  rootIds: string[];
  excludeIds: string[];
  signal: AbortSignal;
  log: (...args: unknown[]) => void;
}): ScopeFilter {
  const roots = new Set(opts.rootIds);
  const excludes = new Set(opts.excludeIds);
  const unrestricted = roots.size === 0 && excludes.size === 0;

  // Cache the resolved parent of each node across the whole crawl.
  const parentCache = new Map<string, NotionParent | null>();

  async function resolveParent(
    kind: 'page' | 'block' | 'database' | 'data_source',
    id: string,
  ): Promise<NotionParent | null> {
    const key = `${kind}:${id}`;
    const cached = parentCache.get(key);
    if (cached !== undefined) return cached;

    let parent: NotionParent | null;
    switch (kind) {
      case 'page':
        parent = await opts.client.getPageParent(id, opts.signal);
        break;
      case 'block':
        parent = await opts.client.getBlockParent(id, opts.signal);
        break;
      case 'database':
        parent = await opts.client.getDatabaseParent(id, opts.signal);
        break;
      case 'data_source':
        parent = await opts.client.getDataSourceParent(id, opts.signal);
        break;
    }
    parentCache.set(key, parent);
    return parent;
  }

  /** Collect normalized ids of the page and all of its ancestors. */
  async function ancestry(page: NotionPageRef): Promise<Set<string>> {
    const ids = new Set<string>([normalizeNotionId(page.id)]);
    let parent = page.parent;
    let depth = 0;

    while (parent && depth < MAX_ANCESTRY_DEPTH) {
      depth++;
      if (opts.signal.aborted) break;

      if (parent.type === 'workspace') break;

      if (parent.type === 'page_id') {
        ids.add(normalizeNotionId(parent.page_id));
        parent = await resolveParent('page', parent.page_id);
      } else if (parent.type === 'block_id') {
        // Blocks aren't useful match targets, but we must traverse them.
        parent = await resolveParent('block', parent.block_id);
      } else if (parent.type === 'database_id') {
        ids.add(normalizeNotionId(parent.database_id));
        parent = await resolveParent('database', parent.database_id);
      } else if (parent.type === 'data_source_id') {
        ids.add(normalizeNotionId(parent.data_source_id));
        parent = await resolveParent('data_source', parent.data_source_id);
      } else {
        break;
      }
    }
    return ids;
  }

  function intersects(a: Set<string>, b: Set<string>): boolean {
    for (const x of a) if (b.has(x)) return true;
    return false;
  }

  return {
    unrestricted,
    async included(page) {
      if (unrestricted) return true;
      const anc = await ancestry(page);
      if (excludes.size > 0 && intersects(anc, excludes)) return false;
      if (roots.size > 0) return intersects(anc, roots);
      return true;
    },
  };
}
