/**
 * Bounded pagination (plan §4 "Pagination"): `--max-pages` defaults to 1
 * with a hard maximum of 10, `--per-page` is at most 100, and the CLI stops
 * at 500 items or at the first error, de-duplicating by `id`.
 */
import { CliError } from "./errors.js";

export const PAGINATION_LIMITS = {
  defaultMaxPages: 1,
  hardMaxPages: 10,
  maxPerPage: 100,
  maxItems: 500,
} as const;

/** Validates `--max-pages` (1..hardMax, default 1). */
export function clampMaxPages(value: number | undefined, hardMax: number = PAGINATION_LIMITS.hardMaxPages): number {
  if (value === undefined) return PAGINATION_LIMITS.defaultMaxPages;
  if (!Number.isInteger(value) || value < 1 || value > hardMax) {
    throw new CliError("INVALID_FLAG_VALUE", `--max-pages must be an integer from 1 to ${hardMax}.`, { humanDecision: false });
  }
  return value;
}

/** Validates `--per-page` (1..100). Returns undefined when not given (server default). */
export function checkPerPage(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > PAGINATION_LIMITS.maxPerPage) {
    throw new CliError("INVALID_FLAG_VALUE", `--per-page must be an integer from 1 to ${PAGINATION_LIMITS.maxPerPage}.`, {
      humanDecision: false,
    });
  }
  return value;
}

/** One fetched page. */
export interface Page<T> {
  items: T[];
  /** True when the server says another page exists. */
  hasMore: boolean;
  meta?: Record<string, unknown> | null;
  /** Opaque cursor for cursor-based lists (journal). */
  nextCursor?: string | null;
}

export type StopReason = "no_more" | "max_pages" | "max_items" | "error";

export interface PaginationResult<T> {
  items: T[];
  pages: number;
  stoppedBecause: StopReason;
  lastMeta: Record<string, unknown> | null;
  nextCursor: string | null;
  /** Set when a page after the first failed; earlier items are kept. */
  error?: CliError;
}

export interface PaginateOptions<T> {
  maxPages: number;
  maxItems?: number;
  /** De-duplication key (default: the item's string `id`). */
  idOf?: (item: T) => string | undefined;
}

function defaultId(item: unknown): string | undefined {
  if (item && typeof item === "object" && "id" in item) {
    const id = (item as { id: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

/**
 * Calls `fetchPage(index, cursor)` (index starts at 1) until the server has no
 * more pages, `maxPages` pages were read, or `maxItems` items were collected.
 * An error on the first page is thrown; a later error stops and is returned.
 * Never retries.
 */
export async function paginate<T>(
  fetchPage: (index: number, cursor: string | null) => Promise<Page<T>>,
  options: PaginateOptions<T>,
): Promise<PaginationResult<T>> {
  const maxItems = options.maxItems ?? PAGINATION_LIMITS.maxItems;
  const idOf = options.idOf ?? ((item: T) => defaultId(item));
  const seen = new Set<string>();
  const items: T[] = [];
  let pages = 0;
  let cursor: string | null = null;
  let lastMeta: Record<string, unknown> | null = null;
  let stoppedBecause: StopReason = "no_more";
  for (let index = 1; ; index += 1) {
    let page: Page<T>;
    try {
      page = await fetchPage(index, cursor);
    } catch (error) {
      if (pages === 0 || !(error instanceof CliError)) throw error;
      return { items, pages, stoppedBecause: "error", lastMeta, nextCursor: cursor, error };
    }
    pages += 1;
    lastMeta = page.meta ?? null;
    cursor = page.nextCursor ?? null;
    for (const item of page.items) {
      const id = idOf(item);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      items.push(item);
      if (items.length >= maxItems) break;
    }
    if (items.length >= maxItems) {
      stoppedBecause = "max_items";
      break;
    }
    if (!page.hasMore) {
      stoppedBecause = "no_more";
      break;
    }
    if (pages >= options.maxPages) {
      stoppedBecause = "max_pages";
      break;
    }
  }
  return { items, pages, stoppedBecause, lastMeta, nextCursor: cursor };
}
