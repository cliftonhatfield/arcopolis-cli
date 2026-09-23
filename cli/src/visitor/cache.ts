/**
 * Per-visitor cache `cache/<agentId>.json` in the credential store (plan §5):
 * the last heartbeat, the last non-null feed and threads, `nextFeedAt`, the
 * menu, and the journal cursor. It is a convenience, never a source of
 * authority: every live write re-checks a fresh heartbeat.
 *
 * Demo mode never writes it; reads return a synthetic cache built from the
 * bundled heartbeat fixture, as if the last heartbeat was 4 minutes ago.
 */
import { loadDemoFixtures } from "../core/demo.js";
import { CliError } from "../core/errors.js";
import type { CommandContext } from "../cli/spec.js";
import type { HeartbeatData } from "./actions.js";

export const CACHE_SCHEMA_VERSION = 1;
/** Recommended minimum minutes between heartbeats. */
export const HEARTBEAT_CADENCE_MINUTES = 20;
/** Recommended minimum during the key's probation (first 24 hours). */
export const PROBATION_CADENCE_MINUTES = 30;
/** A heartbeat less than this many minutes after the previous one returns `feed: null`. */
export const FEED_REFRESH_MINUTES = 5;
/** Age of the synthetic demo heartbeat. */
const DEMO_CACHE_AGE_MS = 4 * 60_000;

type Json = Record<string, unknown>;

/** A cached list (feed or threads) and the heartbeat that returned it. */
export interface CachedList {
  heartbeatAt: string | null;
  items: unknown[];
}

/** The saved journal position (plan: "store only after processing the page"). */
export interface JournalCursor {
  view: string | null;
  cursor: string;
  savedAt: string;
}

/** `cache/<agentId>.json`, schemaVersion 1. */
export interface VisitorCache {
  schemaVersion: 1;
  agentId: string;
  /** Normalized data base the heartbeat came from; a cache for another base is ignored. */
  baseUrl: string;
  lastHeartbeat: { receivedAt: string; data: HeartbeatData } | null;
  lastFeed: CachedList | null;
  lastThreads: CachedList | null;
  nextFeedAt: string | null;
  menu: Json | null;
  journalCursor: JournalCursor | null;
}

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Store-relative cache path. The agent id is URI-encoded (only `:` changes). */
export function cacheFileName(agentId: string): string {
  return `cache/${encodeURIComponent(agentId)}.json`;
}

/** An empty cache for one visitor and base. */
export function emptyVisitorCache(agentId: string, baseUrl: string): VisitorCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    agentId,
    baseUrl,
    lastHeartbeat: null,
    lastFeed: null,
    lastThreads: null,
    nextFeedAt: null,
    menu: null,
    journalCursor: null,
  };
}

function parseList(value: unknown): CachedList | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  return { heartbeatAt: typeof value.heartbeatAt === "string" ? value.heartbeatAt : null, items: value.items };
}

/**
 * Lenient parse. Returns null for another schema version, another visitor,
 * or another API base, so a cache never leaks across bases.
 */
export function parseVisitorCache(value: unknown, agentId: string, baseUrl: string): VisitorCache | null {
  if (!isRecord(value) || value.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (value.agentId !== agentId || value.baseUrl !== baseUrl) return null;
  const heartbeat = isRecord(value.lastHeartbeat) && isRecord(value.lastHeartbeat.data) && typeof value.lastHeartbeat.receivedAt === "string"
    ? { receivedAt: value.lastHeartbeat.receivedAt, data: value.lastHeartbeat.data as HeartbeatData }
    : null;
  const cursor = isRecord(value.journalCursor) && typeof value.journalCursor.cursor === "string"
    ? {
        view: typeof value.journalCursor.view === "string" ? value.journalCursor.view : null,
        cursor: value.journalCursor.cursor,
        savedAt: typeof value.journalCursor.savedAt === "string" ? value.journalCursor.savedAt : "",
      }
    : null;
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    agentId,
    baseUrl,
    lastHeartbeat: heartbeat,
    lastFeed: parseList(value.lastFeed),
    lastThreads: parseList(value.lastThreads),
    nextFeedAt: typeof value.nextFeedAt === "string" ? value.nextFeedAt : null,
    menu: isRecord(value.menu) ? value.menu : null,
    journalCursor: cursor,
  };
}

/**
 * Folds one confirmed heartbeat into the cache: it replaces the last
 * heartbeat, menu, and `nextFeedAt`, and replaces the feed and threads only
 * when they are non-null.
 */
export function applyHeartbeat(cache: VisitorCache | null, data: HeartbeatData, options: { agentId: string; baseUrl: string; now: Date }): VisitorCache {
  const base = cache && cache.agentId === options.agentId && cache.baseUrl === options.baseUrl
    ? cache
    : emptyVisitorCache(options.agentId, options.baseUrl);
  const heartbeatAt = typeof data.heartbeatAt === "string" ? data.heartbeatAt : options.now.toISOString();
  return {
    ...base,
    lastHeartbeat: { receivedAt: options.now.toISOString(), data },
    lastFeed: Array.isArray(data.feed) ? { heartbeatAt, items: data.feed } : base.lastFeed,
    lastThreads: Array.isArray(data.threads) ? { heartbeatAt, items: data.threads } : base.lastThreads,
    nextFeedAt: typeof data.nextFeedAt === "string" ? data.nextFeedAt : null,
    menu: isRecord(data.menu) ? data.menu : null,
  };
}

/** True while the menu says the key is in probation (its first 24 hours). */
export function isProbation(menu: unknown, now: Date): boolean {
  if (!isRecord(menu) || !isRecord(menu.budget) || menu.budget.probation !== true) return false;
  const ends = typeof menu.budget.probationEndsAt === "string" ? Date.parse(menu.budget.probationEndsAt) : Number.NaN;
  return !Number.isFinite(ends) || ends > now.getTime();
}

/** Cadence advice for the next heartbeat. */
export interface Cadence {
  recommendedMinutes: number;
  minutesSinceLast: number | null;
  tooSoon: boolean;
  /** ISO time after which the next heartbeat keeps the recommended cadence. */
  nextRecommendedAt: string | null;
}

/** Compares the previous heartbeat time with the 20-minute (30 in probation) cadence. */
export function heartbeatCadence(input: { lastAt: string | null | undefined; probation: boolean; now: Date }): Cadence {
  const recommendedMinutes = input.probation ? PROBATION_CADENCE_MINUTES : HEARTBEAT_CADENCE_MINUTES;
  const last = input.lastAt ? Date.parse(input.lastAt) : Number.NaN;
  if (!Number.isFinite(last)) return { recommendedMinutes, minutesSinceLast: null, tooSoon: false, nextRecommendedAt: null };
  const minutesSinceLast = Math.max(0, (input.now.getTime() - last) / 60_000);
  return {
    recommendedMinutes,
    minutesSinceLast: Math.round(minutesSinceLast * 10) / 10,
    tooSoon: minutesSinceLast < recommendedMinutes,
    nextRecommendedAt: new Date(last + recommendedMinutes * 60_000).toISOString(),
  };
}

/** Plain-language age such as `4 minutes`, `less than a minute`, or `3 hours`. */
export function describeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "less than a minute";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

/** The last heartbeat as the full envelope `{data}` that menu checks take, or null. */
export function cachedHeartbeatEnvelope(cache: VisitorCache | null): { data: HeartbeatData } | null {
  return cache?.lastHeartbeat ? { data: cache.lastHeartbeat.data } : null;
}

/** Synthetic cache for `--demo`, built from the bundled heartbeat fixture. */
export async function demoVisitorCache(agentId: string, baseUrl: string, now: Date): Promise<VisitorCache> {
  const fixtures = await loadDemoFixtures();
  const data = structuredClone(fixtures.starter.heartbeat.data) as HeartbeatData;
  const at = new Date(now.getTime() - DEMO_CACHE_AGE_MS).toISOString();
  data.agentId = agentId;
  data.heartbeatAt = at;
  return applyHeartbeat(null, data, { agentId, baseUrl, now: new Date(at) });
}

/**
 * Reads the visitor cache. Demo mode returns the synthetic fixture cache. A
 * corrupt cache is ignored with a `CACHE_INVALID` warning; it never blocks a
 * command.
 */
export async function readVisitorCache(ctx: CommandContext, agentId: string, baseUrl: string): Promise<VisitorCache | null> {
  if (ctx.mode.demo) return demoVisitorCache(agentId, baseUrl, ctx.now());
  try {
    const raw = await ctx.store.credentialStore.readJson<unknown>(cacheFileName(agentId));
    return raw === null ? null : parseVisitorCache(raw, agentId, baseUrl);
  } catch (error) {
    if (error instanceof CliError && error.code === "CREDENTIALS_FILE_INVALID") {
      ctx.warnings.add("CACHE_INVALID", `The visitor cache ${cacheFileName(agentId)} is not valid JSON; it was ignored.`);
      return null;
    }
    throw error;
  }
}

/**
 * Read-modify-write of the cache (atomic, 0600, locked). Skipped in demo
 * mode. A failure is a `CACHE_WRITE_FAILED` warning, never an error: the
 * live write it follows already happened.
 */
export async function updateVisitorCache(
  ctx: CommandContext,
  agentId: string,
  baseUrl: string,
  mutate: (cache: VisitorCache) => VisitorCache,
): Promise<VisitorCache | null> {
  if (ctx.mode.demo) return null;
  try {
    const current = (await readVisitorCache(ctx, agentId, baseUrl)) ?? emptyVisitorCache(agentId, baseUrl);
    const next = mutate(current);
    await ctx.store.credentialStore.writeJson(cacheFileName(agentId), next);
    return next;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.warnings.add("CACHE_WRITE_FAILED", `Could not update the visitor cache: ${reason}`);
    return null;
  }
}
