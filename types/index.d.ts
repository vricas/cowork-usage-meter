/**
 * State contract for cowork-usage-meter.
 *
 * Session state ($.state) holds one conversation's figures and survives a
 * plugin reload. The pilot log lives in $.store (see hooks/log.ts) and holds
 * counts and timestamps only, never conversation content.
 */

/** The latest figures, taken from a `session.measure` event. */
export type Reading = {
  /** When the reading was taken (ms since the epoch). */
  at: number
  /** Context tokens; null while pending (no response yet, or just compacted). */
  ctxTokens: number | null
  /** Context as a whole percentage of the window; null while pending. */
  ctxPercent: number | null
  /** The model's context window, in tokens. */
  ctxWindow: number
  /** Five-hour window percent used; null when no reading. */
  fiveHour: number | null
  /** Seven-day window percent used; null when no reading. */
  weekly: number | null
  /** True while any plan window reads 100% or more (usage credits assumed). */
  atLimit: boolean
}

/** The per-conversation share of the weekly limit. */
export type Budget = {
  /** Weekly percent at the current baseline; null before the first reading. */
  baseline: number | null
  /** Points counted before the current baseline (resets, long gaps). */
  carried: number
  /** The weekly percent last seen. */
  lastWeekly: number | null
  /** Set when a message is sent after an idle gap past the cache lifetime. */
  rebasePending: boolean
}

/** Which warnings have fired for the current crossing, and dismissals. */
export type Warnings = {
  /** Five-hour thresholds already toasted in the current crossing. */
  fiveHourFired: number[]
  /** The budget's 80% toast has fired for this crossing. */
  budgetToasted: boolean
  /** The budget has reached 100% (its band is due). */
  budgetReached: boolean
  /** The budget band was dismissed for this crossing. */
  budgetDismissed: boolean
  /** The context passed its threshold (its band is due). */
  contextReached: boolean
  /** The context band was dismissed for this crossing. */
  contextDismissed: boolean
  /** The idle episode (its lastTurnAt) whose cold-cache band was dismissed. */
  coldDismissedFor: number | null
}

/** Idle tracking for the cold-cache rule. */
export type Idle = {
  /** When the last main-conversation turn ended; null before the first. */
  lastTurnAt: number | null
  /** The cache lifetime in force when that turn ended, in ms. */
  lifetimeMs: number
  /** The lifetime was cut to 5 minutes because a plan window read 100%. */
  isCreditLifetime: boolean
  /** The idle gap has passed the lifetime and no message has been sent since. */
  isCold: boolean
}

/** The current turn's first request, held until the turn completes. */
export type TurnOpening = {
  /** When the turn started (ms). */
  startedAt: number
  /** Idle gap before the turn, in ms; null for the conversation's first. */
  gapMs: number | null
  /** The model that answered the first request. */
  model: string | null
  /** First request: uncached input tokens. */
  input: number | null
  /** First request: cache-read input tokens. */
  cacheRead: number | null
  /** First request: cache-write input tokens. */
  cacheWrite: number | null
  /**
   * The Chat figure will not count this turn: it is the conversation's first
   * (no baseline yet) or the first after a gap past the cache lifetime.
   */
  isChatExcluded: boolean
}

/** The log pane's own view state. */
export type LogView = {
  /** The Clear button was pressed once and awaits confirmation. */
  isClearArmed: boolean
  /** Copying failed on this surface, so the CSV is shown for manual copying. */
  isCsvShown: boolean
  /** Bumped on every log write so the pane redraws. */
  revision: number
  /** The last copy or clear outcome, shown under the buttons. */
  notice: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'cowork-usage-meter': {
      reading: Shaped<Reading | null>
      budget: Shaped<Budget>
      warnings: Shaped<Warnings>
      idle: Shaped<Idle>
      opening: Shaped<TurnOpening | null>
      logView: Shaped<LogView>
    }
  }
}
