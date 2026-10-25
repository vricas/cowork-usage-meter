/**
 * Pure rules for the Usage Meter: formatting, budget accounting, threshold
 * crossings and the cache lifetime. No engine calls, no I/O.
 */

import type { SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Budget, Reading, Warnings } from '../types'

export const MINUTE = 60_000
/** The documented cache lifetime once usage credits apply. */
export const CREDIT_LIFETIME_MS = 5 * MINUTE

export type Settings = {
  conversationBudget: number
  fiveHourThresholds: number[]
  contextThreshold: number
  cacheLifetimeMs: number
  coldCacheMinTokens: number
  showContext: boolean
  showFiveHour: boolean
  showWeekly: boolean
  showChat: boolean
}

/** Reads the plugin's options, falling back to the spec's defaults. */
export function settingsFrom(options: Readonly<Record<string, unknown>>): Settings {
  const num = (key: string, fallback: number): number => {
    const value = options[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  const flag = (key: string): boolean => options[key] !== false
  const thresholds = options['fiveHourThresholds']

  return {
    conversationBudget: Math.max(0, num('conversationBudget', 2)),
    fiveHourThresholds: parseThresholds(typeof thresholds === 'string' ? thresholds : '80, 95'),
    contextThreshold: num('contextThreshold', 150_000),
    cacheLifetimeMs: Math.max(1, num('cacheLifetimeMinutes', 60)) * MINUTE,
    coldCacheMinTokens: num('coldCacheMinTokens', 50_000),
    showContext: flag('showContext'),
    showFiveHour: flag('showFiveHour'),
    showWeekly: flag('showWeekly'),
    showChat: flag('showChat'),
  }
}

/** "80, 95" → [80, 95]: numbers above 0 and at most 100, sorted, no repeats. */
export function parseThresholds(text: string): number[] {
  const values = text
    .split(',')
    .map(part => Number(part.trim().replace(/%$/, '')))
    .filter(value => Number.isFinite(value) && value > 0 && value <= 100)

  return [...new Set(values)].sort((a, b) => a - b)
}

/** Rounds to one decimal, removing floating-point noise from subtraction. */
export function tenths(value: number): number {
  return Math.round(value * 10) / 10
}

/** 142318 → "142k"; 950 → "950"; 1_200_000 → "1.2M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/** Points of the weekly limit: under 0.1 shows "<0.1". */
export function formatPoints(points: number): string {
  return points < 0.1 ? '<0.1' : tenths(points).toFixed(1)
}

/** Whole-number percent, never rounded up to a limit not yet reached. */
export function formatPercent(percent: number): string {
  return `${Math.floor(percent)}%`
}

/** Turns a measurement into the meter's reading. */
export function readingFrom(
  context: SessionContextUsage,
  rateLimits: readonly SessionRateLimit[],
  at: number,
): Reading {
  const find = (kind: string) => rateLimits.find(limit => limit.kind === kind)?.percentUsed ?? null
  const fiveHour = find('five_hour')
  const weekly = find('seven_day')
  const isPending = context.tokens === undefined

  return {
    at,
    ctxTokens: isPending ? null : (context.tokens ?? null),
    ctxPercent: isPending ? null : (context.percent ?? null),
    ctxWindow: context.window,
    fiveHour,
    weekly,
    atLimit: rateLimits.some(
      limit => (limit.kind === 'five_hour' || limit.kind === 'seven_day') && limit.percentUsed >= 100,
    ),
  }
}

export const EMPTY_BUDGET: Budget = { baseline: null, carried: 0, lastWeekly: null, rebasePending: false }

/**
 * Moves the budget on by one weekly reading.
 *
 * - First reading: becomes the baseline.
 * - After a long idle gap: the use up to the gap is carried and a new baseline
 *   taken, so other conversations' use during the gap is not counted.
 * - A drop (the weekly window reset): the pre-reset use is carried and a new
 *   baseline taken.
 */
export function advanceBudget(budget: Budget, weekly: number | null): Budget {
  if (weekly === null) return budget
  if (budget.baseline === null || budget.lastWeekly === null) {
    return { ...budget, baseline: weekly, lastWeekly: weekly, rebasePending: false }
  }
  if (budget.rebasePending || weekly < budget.lastWeekly) {
    const carried = tenths(budget.carried + Math.max(0, budget.lastWeekly - budget.baseline))
    return { baseline: weekly, carried, lastWeekly: weekly, rebasePending: false }
  }
  return { ...budget, lastWeekly: weekly }
}

/** Points of the weekly limit this conversation has used; null before a baseline. */
export function conversationPoints(budget: Budget): number | null {
  if (budget.baseline === null || budget.lastWeekly === null) return null
  return tenths(budget.carried + Math.max(0, budget.lastWeekly - budget.baseline))
}

/** The status line text; undefined when every segment is off or empty. */
export function statusLine(reading: Reading | null, points: number | null, settings: Settings): string | undefined {
  const parts: string[] = []

  if (settings.showContext) {
    if (reading === null || reading.ctxTokens === null) {
      parts.push('Ctx pending')
    } else {
      const percent = reading.ctxPercent === null ? '' : ` (${formatPercent(reading.ctxPercent)})`
      parts.push(`Ctx ${formatTokens(reading.ctxTokens)}${percent}`)
    }
  }
  if (settings.showFiveHour && reading?.fiveHour != null) {
    parts.push(`5h ${formatPercent(reading.fiveHour)}`)
  }
  if (settings.showWeekly && reading?.weekly != null) {
    parts.push(`Wk ${formatPercent(reading.weekly)}`)
  }
  if (settings.showChat && reading?.weekly != null && points !== null) {
    parts.push(`Chat ${formatPoints(points)} pts`)
  }

  return parts.length === 0 ? undefined : parts.join(' · ')
}

export const EMPTY_WARNINGS: Warnings = {
  fiveHourFired: [],
  budgetToasted: false,
  budgetReached: false,
  budgetDismissed: false,
  contextReached: false,
  contextDismissed: false,
  coldDismissedFor: null,
}

export type Toast = { text: string }

/**
 * Applies one reading to the warning state: what to toast now, and the new
 * state. Each warning fires once per crossing; falling back below a level
 * re-arms it. A missing reading never warns and never re-arms.
 */
export function advanceWarnings(
  warnings: Warnings,
  reading: Reading,
  points: number | null,
  settings: Settings,
): { warnings: Warnings; toasts: Toast[] } {
  const toasts: Toast[] = []
  let next = { ...warnings }

  // Five-hour thresholds.
  if (reading.fiveHour !== null) {
    const current = reading.fiveHour
    const stillPast = next.fiveHourFired.filter(threshold => current >= threshold)
    const newlyPast = settings.fiveHourThresholds.filter(
      threshold => current >= threshold && !stillPast.includes(threshold),
    )
    if (newlyPast.length > 0) {
      const highest = newlyPast[newlyPast.length - 1]
      toasts.push({ text: `Five-hour limit at ${formatPercent(current)}, past your ${highest}% threshold.` })
    }
    next = { ...next, fiveHourFired: [...stillPast, ...newlyPast].sort((a, b) => a - b) }
  }

  // Per-conversation budget.
  const budget = settings.conversationBudget
  if (budget > 0 && points !== null) {
    const share = points / budget
    if (share < 0.8) {
      next = { ...next, budgetToasted: false }
    } else if (!next.budgetToasted) {
      if (share < 1) {
        toasts.push({
          text: `This conversation has used ${formatPoints(points)} of its ${budget.toFixed(1)}-point weekly budget.`,
        })
      }
      next = { ...next, budgetToasted: true }
    }
    if (share < 1) {
      next = { ...next, budgetReached: false, budgetDismissed: false }
    } else if (!next.budgetReached) {
      next = { ...next, budgetReached: true, budgetDismissed: false }
    }
  }

  // Context size.
  if (reading.ctxTokens !== null) {
    const isPast = reading.ctxTokens >= settings.contextThreshold
    if (!isPast) {
      next = { ...next, contextReached: false, contextDismissed: false }
    } else if (!next.contextReached) {
      next = { ...next, contextReached: true, contextDismissed: false }
    }
  }

  return { warnings: next, toasts }
}

/** The cache lifetime in force: the setting, or 5 minutes on usage credits. */
export function lifetimeFor(settings: Settings, reading: Reading | null): { ms: number; isCredit: boolean } {
  return reading?.atLimit === true
    ? { ms: CREDIT_LIFETIME_MS, isCredit: true }
    : { ms: settings.cacheLifetimeMs, isCredit: false }
}
