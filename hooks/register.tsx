/**
 * Cowork Usage Meter: an independent plugin, not an Anthropic product.
 *
 * Reads token counts, limit percentages, reset times and timestamps; never
 * messages, files or tool output. Makes no network calls and no model calls.
 * Session state holds one conversation's figures; $.store holds the pilot log
 * (counts and timestamps only) and nothing else.
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Budget, Idle, LogView, Reading, TurnOpening, Warnings } from '../types'
import {
  advanceBudget,
  advanceWarnings,
  conversationPoints,
  EMPTY_BUDGET,
  EMPTY_WARNINGS,
  formatPoints,
  formatTokens,
  lifetimeFor,
  MINUTE,
  readingFrom,
  settingsFrom,
  statusLine,
} from './meter'
import type { Settings } from './meter'
import { allKinds, allTurns, appendTurn, clearTurns, noteKinds, toCsv, trimLog, TRIM_EVERY } from './log'
import type { TurnRecord } from './log'

const PLUGIN = 'cowork-usage-meter'
const PANE = 'usage-meter-log'
const PANE_TITLE = 'Usage Meter log'

// Change a shape tag when that value's fields change: a reload then reads an
// older stored value as absent instead of misreading it.
const readingAtom = atom({ plugin: 'cowork-usage-meter', key: 'reading' } as const, null as Reading | null, { shape: 'reading-1' })
const budgetAtom = atom({ plugin: 'cowork-usage-meter', key: 'budget' } as const, EMPTY_BUDGET as Budget, { shape: 'budget-1' })
const warningsAtom = atom({ plugin: 'cowork-usage-meter', key: 'warnings' } as const, EMPTY_WARNINGS as Warnings, {
  shape: 'warnings-1',
})
const EMPTY_IDLE: Idle = { lastTurnAt: null, lifetimeMs: 60 * MINUTE, isCreditLifetime: false, isCold: false }
const idleAtom = atom({ plugin: 'cowork-usage-meter', key: 'idle' } as const, EMPTY_IDLE, { shape: 'idle-1' })
const openingAtom = atom({ plugin: 'cowork-usage-meter', key: 'opening' } as const, null as TurnOpening | null, {
  shape: 'opening-2',
})
const EMPTY_LOG_VIEW: LogView = { isClearArmed: false, isCsvShown: false, revision: 0, notice: null }
const logViewAtom = atom({ plugin: 'cowork-usage-meter', key: 'logView' } as const, EMPTY_LOG_VIEW, { shape: 'log-view-1' })

// Module variables start over on a reload, as do the engine's timers; the
// cold-cache timer is re-armed from session state in session.start.
let coldTimer: { cancel: () => void } | null = null
let appendsSinceTrim = 0

function cancelColdTimer(): void {
  coldTimer?.cancel()
  coldTimer = null
}

/** Marks the conversation cold once the idle gap passes the lifetime. */
async function armColdTimer($: EngineInterface): Promise<void> {
  cancelColdTimer()
  const idle = await read($, idleAtom)
  if (idle.lastTurnAt === null || idle.isCold) return
  const lastTurnAt = idle.lastTurnAt
  const remaining = lastTurnAt + idle.lifetimeMs - (await $.clock.now())
  const markCold = () => {
    coldTimer = null
    void update($, idleAtom, now => (now.lastTurnAt === lastTurnAt ? { ...now, isCold: true } : now))
  }
  if (remaining <= 0) markCold()
  else coldTimer = $.clock.after(remaining, markCold)
}

/** Draws the status line from session state. */
async function showStatus($: EngineInterface, settings: Settings): Promise<void> {
  const reading = await read($, readingAtom)
  const points = conversationPoints(await read($, budgetAtom))
  $.ui.status(statusLine(reading, points, settings))
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-meter-log', description: 'Show the Usage Meter pilot log in a pane' })
    await showStatus($, settings)
    await armColdTimer($)
    await trimLog($, await $.clock.now())
    return next(e)
  })

  // A /clear starts a new conversation: its figures and warnings start over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      cancelColdTimer()
      await update($, readingAtom, () => null)
      await update($, budgetAtom, () => EMPTY_BUDGET)
      await update($, warningsAtom, () => EMPTY_WARNINGS)
      await update($, idleAtom, () => EMPTY_IDLE)
      await update($, openingAtom, () => null)
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const reading = readingFrom(e.context, e.rateLimits, now)
    await update($, readingAtom, () => reading)

    const budget = await update($, budgetAtom, held => advanceBudget(held, reading.weekly))
    const points = conversationPoints(budget)
    const held = await read($, warningsAtom)
    const { warnings, toasts } = advanceWarnings(held, reading, points, settings)
    await update($, warningsAtom, () => warnings)
    for (const toast of toasts) $.ui.toast(toast.text)

    $.ui.status(statusLine(reading, points, settings))
    await noteKinds($, await $.session.id(), e.rateLimits, now)
    return next(e)
  })

  // A main-conversation turn begins: the message has been sent.
  // Reads only agentId; never the prompt's text.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const idle = await read($, idleAtom)
    const gapMs = idle.lastTurnAt === null ? null : now - idle.lastTurnAt

    const isLongGap = gapMs !== null && gapMs > idle.lifetimeMs
    if (isLongGap) {
      await update($, budgetAtom, held => (held.baseline === null ? held : { ...held, rebasePending: true }))
    }
    // The next weekly reading becomes this turn's baseline, so its use is not
    // in the Chat figure; the log marks the turn so the pilot can measure it.
    const budget = await read($, budgetAtom)
    const isChatExcluded = budget.baseline === null || budget.rebasePending
    cancelColdTimer()
    await update($, idleAtom, held => ({ ...held, isCold: false }))
    await update($, openingAtom, () => ({
      startedAt: now,
      gapMs,
      model: null,
      input: null,
      cacheRead: null,
      cacheWrite: null,
      isChatExcluded,
    }))
    return next(e)
  })

  // The turn's first request shows whether the cache survived the idle gap.
  // Every request passes through unchanged; only `index` and `usage` are read,
  // never `answer` or `toolUses`.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && e.index === 0 && result.usage !== null) {
      const usage = result.usage
      await update($, openingAtom, held =>
        held === null
          ? held
          : {
              ...held,
              model: usage.model,
              input: usage.input_tokens,
              cacheRead: usage.cache_read_input_tokens,
              cacheWrite: usage.cache_creation_input_tokens,
            },
      )
    }
    return result
  })

  // A main-conversation turn ended: log it, and start the idle clock.
  // Reads only agentId; never the answer.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const reading = await read($, readingAtom)
    const lifetime = lifetimeFor(settings, reading)
    await update($, idleAtom, () => ({
      lastTurnAt: now,
      lifetimeMs: lifetime.ms,
      isCreditLifetime: lifetime.isCredit,
      isCold: false,
    }))
    await armColdTimer($)

    // A local estimate: no request is sent. Only apiUsage and the
    // auto-compaction threshold are read from it.
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    const opening = await read($, openingAtom)
    const record: TurnRecord = {
      t: now,
      g: opening?.gapMs ?? null,
      m: opening?.model ?? null,
      fi: opening?.input ?? null,
      fr: opening?.cacheRead ?? null,
      fw: opening?.cacheWrite ?? null,
      li: breakdown?.apiUsage?.input_tokens ?? null,
      lr: breakdown?.apiUsage?.cache_read_input_tokens ?? null,
      lw: breakdown?.apiUsage?.cache_creation_input_tokens ?? null,
      ac: breakdown?.autoCompactThreshold ?? null,
      ct: usage.context.tokens ?? null,
      x: opening?.isChatExcluded ?? false,
    }
    await update($, openingAtom, () => null)
    await appendTurn($, await $.session.id(), record, now)
    appendsSinceTrim += 1
    if (appendsSinceTrim >= TRIM_EVERY) {
      appendsSinceTrim = 0
      await trimLog($, now)
    }
    await update($, logViewAtom, view => ({ ...view, revision: view.revision + 1 }))
    return next(e)
  })

  on('command.run', { command: 'usage-meter-log' }, async $ => {
    await update($, logViewAtom, view => ({ ...view, isClearArmed: false, notice: null }))
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'Opened the Usage Meter log.' }
  })

  // Warnings above the prompt: context size, cold cache, budget reached.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const reading = await read($, readingAtom)
    const warnings = await read($, warningsAtom)
    const idle = await read($, idleAtom)
    const budget = await read($, budgetAtom)
    const points = conversationPoints(budget)
    const lines: { key: string; text: string; dismiss: () => Promise<unknown> }[] = []

    if (reading !== null && reading.ctxTokens !== null && warnings.contextReached && !warnings.contextDismissed) {
      lines.push({
        key: 'context',
        text: `Context is ${formatTokens(reading.ctxTokens)} tokens, past your ${formatTokens(settings.contextThreshold)} threshold. Consider starting a fresh conversation with a handoff note.`,
        dismiss: () => update($, warningsAtom, held => ({ ...held, contextDismissed: true })),
      })
    }
    if (
      idle.isCold &&
      idle.lastTurnAt !== null &&
      reading !== null &&
      reading.ctxTokens !== null &&
      reading.ctxTokens >= settings.coldCacheMinTokens &&
      warnings.coldDismissedFor !== idle.lastTurnAt
    ) {
      const minutes = Math.round(idle.lifetimeMs / MINUTE)
      const credit = idle.isCreditLifetime
        ? ' A plan window reads 100%, so usage credits are assumed and the cache lifetime is 5 minutes.'
        : ''
      const lastTurnAt = idle.lastTurnAt
      lines.push({
        key: 'cold',
        text: `Idle past the ${minutes}-minute cache lifetime: your next message re-reads all ${formatTokens(reading.ctxTokens)} tokens at the full rate.${credit}`,
        dismiss: () => update($, warningsAtom, held => ({ ...held, coldDismissedFor: lastTurnAt })),
      })
    }
    if (settings.conversationBudget > 0 && points !== null && warnings.budgetReached && !warnings.budgetDismissed) {
      lines.push({
        key: 'budget',
        text: `This conversation has used ${formatPoints(points)} points of the weekly limit, past its ${settings.conversationBudget.toFixed(1)}-point budget (approximate).`,
        dismiss: () => update($, warningsAtom, held => ({ ...held, budgetDismissed: true })),
      })
    }
    if (lines.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Box flexDirection="row">
            <Text wrap="wrap">{line.text} </Text>
            <Button key={`dismiss-${line.key}`} label="Dismiss" onPress={() => line.dismiss()} />
          </Box>
        ))}
      </Box>
    )
  })

  // The pilot log: rate-limit kinds seen, recent turns, copy and clear.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await read($, logViewAtom)
    const turns = await allTurns($)
    const kinds = await allKinds($)
    const { Box, Button, Text, Code } = $.ui.resolve(e)
    const room = Math.max(3, e.props.scroll.bodyRows - 12)
    const recent = turns.slice(-room)
    const clock = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
    const count = (n: number | null) => (n === null ? '-' : formatTokens(n))

    const copy = async (surface: typeof e.surface) => {
      const result = await $.ui.copy({ text: toCsv(await allTurns($)), surface })
      await update($, logViewAtom, held =>
        result.isCopied
          ? { ...held, notice: 'Copied the log as CSV.', isCsvShown: false }
          : { ...held, notice: 'Copying is not available here; the CSV is shown below to select.', isCsvShown: true },
      )
    }
    const clear = async () => {
      if (!view.isClearArmed) {
        await update($, logViewAtom, held => ({ ...held, isClearArmed: true, notice: null }))
        return
      }
      const removed = await clearTurns($)
      await update($, logViewAtom, held => ({
        ...held,
        isClearArmed: false,
        isCsvShown: false,
        revision: held.revision + 1,
        notice: `Cleared ${removed} turns. Rate-limit kinds seen are kept.`,
      }))
    }

    return (
      <Box flexDirection="column">
        <Text bold>Rate-limit kinds seen</Text>
        {Object.keys(kinds).length === 0 && <Text dimColor>None yet.</Text>}
        {Object.entries(kinds).map(([kind, seen]) => (
          <Text>
            {kind}: {seen.p}% (first {clock(seen.f)}, last {clock(seen.l)} UTC)
          </Text>
        ))}
        <Text bold>
          Turns logged: {turns.length}
          {turns.length > 0 ? ` since ${clock(turns[0]?.t ?? 0)} UTC` : ''}
        </Text>
        {recent.length === 0 && <Text dimColor>No turns yet.</Text>}
        {recent.length > 0 && <Text dimColor>ended (UTC) · idle min · first read/write · last read/write</Text>}
        {recent.map(turn => (
          <Text>
            {clock(turn.t)} · {turn.g === null ? '-' : (turn.g / MINUTE).toFixed(1)} · {count(turn.fr)}/{count(turn.fw)} ·{' '}
            {count(turn.lr)}/{count(turn.lw)}
          </Text>
        ))}
        <Box flexDirection="row">
          <Button key="copy" label="Copy as CSV" onPress={press => copy(press.surface)} />
          <Button key="clear" label={view.isClearArmed ? 'Confirm clear' : 'Clear log'} onPress={() => clear()} />
        </Box>
        {view.notice !== null && <Text dimColor>{view.notice}</Text>}
        {view.isCsvShown && <Code language="csv" source={toCsv(turns)} />}
      </Box>
    )
  })
}
