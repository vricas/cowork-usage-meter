/**
 * The pilot log, kept in $.store across sessions.
 *
 * It holds counts and timestamps only, never conversation content:
 * - `turns:<session id>`: one record per main-conversation turn (TurnRecord).
 * - `kinds:<session id>`: every rate-limit kind seen (KindsSeen), never trimmed.
 *
 * Each session writes only its own keys, so parallel sessions never overwrite
 * one another. The whole log keeps the newest 14 days or 5,000 turns, whichever
 * is smaller; the record of kinds seen is never dropped by the cap.
 */

import type { EngineInterface, SessionRateLimit } from 'claude-code'

export const TURNS_PREFIX = 'turns:'
export const KINDS_PREFIX = 'kinds:'
export const MAX_AGE_MS = 14 * 24 * 60 * 60_000
export const MAX_TURNS = 5000
/** How many appends between whole-log trims (each append trims its own key). */
export const TRIM_EVERY = 50

/** One turn, as compact JSON. */
export type TurnRecord = {
  /** When the turn ended (ms). */
  t: number
  /** Idle gap before the turn (ms); null for a conversation's first turn. */
  g: number | null
  /** Model that answered the first request. */
  m: string | null
  /** First request: uncached input, cache-read and cache-write tokens. */
  fi: number | null
  fr: number | null
  fw: number | null
  /** Last response (summary breakdown's apiUsage): the same three counts. */
  li: number | null
  lr: number | null
  lw: number | null
  /** Auto-compaction threshold in tokens; null when off or unknown. */
  ac: number | null
  /** Context tokens after the turn; null while pending. */
  ct: number | null
  /** The Chat figure excludes this turn (a first turn, or first after a long gap). */
  x?: boolean
}

/** A rate-limit kind: first and last seen (ms) and its last percent used. */
export type KindSeen = { f: number; l: number; p: number }
export type KindsSeen = Record<string, KindSeen>


function isRecord(value: unknown): value is TurnRecord {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'number'
}

async function readTurns($: EngineInterface, key: string): Promise<TurnRecord[]> {
  const value = await $.store.get(key)
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** Drops records older than the age cap and keeps the newest MAX_TURNS. */
export function capRecords(records: readonly TurnRecord[], now: number): TurnRecord[] {
  return records
    .filter(record => record.t >= now - MAX_AGE_MS)
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_TURNS)
}

/** Appends a turn to this session's key, capping that key as it goes. */
export async function appendTurn($: EngineInterface, sessionId: string, record: TurnRecord, now: number): Promise<void> {
  const key = TURNS_PREFIX + sessionId
  const records = await readTurns($, key)
  await $.store.set(key, capRecords([...records, record], now))
}

/** Applies the cap to the whole log, across every session's key. */
export async function trimLog($: EngineInterface, now: number): Promise<void> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(TURNS_PREFIX))
  const all: { key: string; record: TurnRecord }[] = []
  for (const key of keys) {
    for (const record of await readTurns($, key)) all.push({ key, record })
  }
  const kept = new Set(capRecords(all.map(entry => entry.record), now))
  for (const key of keys) {
    const mine = all.filter(entry => entry.key === key && kept.has(entry.record)).map(entry => entry.record)
    const before = all.filter(entry => entry.key === key).length
    if (mine.length === 0) await $.store.delete(key)
    else if (mine.length !== before) await $.store.set(key, mine)
  }
}

/** Records every rate-limit kind in a reading under this session's key. */
export async function noteKinds(
  $: EngineInterface,
  sessionId: string,
  rateLimits: readonly SessionRateLimit[],
  now: number,
): Promise<void> {
  if (rateLimits.length === 0) return
  const key = KINDS_PREFIX + sessionId
  const stored = await $.store.get(key)
  const kinds: KindsSeen = typeof stored === 'object' && stored !== null ? { ...(stored as KindsSeen) } : {}
  for (const limit of rateLimits) {
    const seen = kinds[limit.kind]
    kinds[limit.kind] = { f: seen?.f ?? now, l: now, p: limit.percentUsed }
  }
  await $.store.set(key, kinds)
}

/** Every turn in the log, oldest first. */
export async function allTurns($: EngineInterface): Promise<TurnRecord[]> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(TURNS_PREFIX))
  const records: TurnRecord[] = []
  for (const key of keys) records.push(...(await readTurns($, key)))
  return records.sort((a, b) => a.t - b.t)
}

/** Every rate-limit kind seen across sessions, merged. */
export async function allKinds($: EngineInterface): Promise<KindsSeen> {
  const merged: KindsSeen = {}
  for (const key of (await $.store.keys()).filter(one => one.startsWith(KINDS_PREFIX))) {
    const stored = await $.store.get(key)
    if (typeof stored !== 'object' || stored === null) continue
    for (const [kind, seen] of Object.entries(stored as KindsSeen)) {
      const before = merged[kind]
      merged[kind] =
        before === undefined
          ? seen
          : { f: Math.min(before.f, seen.f), l: Math.max(before.l, seen.l), p: seen.l >= before.l ? seen.p : before.p }
    }
  }
  return merged
}

/** Removes every turn record; the record of kinds seen is kept. */
export async function clearTurns($: EngineInterface): Promise<number> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(TURNS_PREFIX))
  let count = 0
  for (const key of keys) {
    count += (await readTurns($, key)).length
    await $.store.delete(key)
  }
  return count
}

const CSV_HEADER = [
  'ended_at_utc',
  'idle_gap_min',
  'model',
  'first_input',
  'first_cache_read',
  'first_cache_write',
  'last_input',
  'last_cache_read',
  'last_cache_write',
  'auto_compact_threshold',
  'context_tokens',
  'chat_excluded',
].join(',')

const cell = (value: number | string | null): string => {
  if (value === null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The turn log as CSV, one header row then one row per turn. */
export function toCsv(records: readonly TurnRecord[]): string {
  const rows = records.map(record =>
    [
      new Date(record.t).toISOString(),
      record.g === null ? null : (record.g / 60_000).toFixed(1),
      record.m,
      record.fi,
      record.fr,
      record.fw,
      record.li,
      record.lr,
      record.lw,
      record.ac,
      record.ct,
      record.x === undefined ? null : record.x ? 'yes' : 'no',
    ]
      .map(cell)
      .join(','),
  )
  return [CSV_HEADER, ...rows].join('\n')
}
