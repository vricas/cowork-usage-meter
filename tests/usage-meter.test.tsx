import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

import { capRecords, MAX_AGE_MS, MAX_TURNS, toCsv } from '../hooks/log'
import type { TurnRecord } from '../hooks/log'
import { formatPoints, formatTokens, parseThresholds } from '../hooks/meter'

const PLUGIN = 'cowork-usage-meter'
const MIN = 60_000
const WINDOW = 1_000_000
const START = Date.UTC(2026, 9, 26, 0, 0, 0)

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'usage-meter-log',
  props: {
    title: 'Usage Meter log',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Step = { input: number; cacheRead: number; cacheWrite: number }

/** Stands in for the engine beneath the plugin, recording what it shows. */
function world(on: On) {
  const clock: MockClock = mock.clock(on, { now: START })
  // The plugin's own store, held here so a test can read it back.
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  // The engine's own drawing, where the plugin draws nothing.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const shown = { toasts: [] as string[], status: undefined as string | undefined, copies: [] as string[] }
  let ctxTokens: number | undefined
  let nextStep: Step = { input: 10, cacheRead: 0, cacheWrite: 0 }

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: {
        window: WINDOW,
        tokens: ctxTokens,
        breakdown: { apiUsage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 7 }, autoCompactThreshold: 800_000 },
      },
      rateLimits: [],
    } as never,
  }))
  on('command.register', () => ({ value: { command: 'usage-meter-log' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    shown.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    shown.status = e.text
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    shown.copies.push(e.text)
    return { value: { isCopied: e.surface === 'terminal' } as never }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-test',
        input_tokens: nextStep.input,
        cache_read_input_tokens: nextStep.cacheRead,
        cache_creation_input_tokens: nextStep.cacheWrite,
        output_tokens: 1,
      },
    }
  })

  return {
    clock,
    shown,
    store,
    setStep(step: Step) {
      nextStep = step
    },
    /** One measurement, as the engine raises it after a turn. */
    async measure($: Engine, args: { ctx?: number; fiveHour?: number; weekly?: number }) {
      ctxTokens = args.ctx
      const rateLimits: SessionRateLimit[] = []
      if (args.fiveHour !== undefined) rateLimits.push({ kind: 'five_hour', percentUsed: args.fiveHour })
      if (args.weekly !== undefined) rateLimits.push({ kind: 'seven_day', percentUsed: args.weekly })
      await $.session.measure({
        context: {
          window: WINDOW,
          tokens: args.ctx,
          percent: args.ctx === undefined ? undefined : Math.floor((args.ctx / WINDOW) * 100),
        },
        rateLimits,
        changed: ['context', 'rateLimits'],
      })
    },
    /** A whole main-conversation turn: start, two requests, complete. */
    async turn($: Engine, id: string, agentId?: string) {
      await $.turn.start({ text: 'not read', turnId: id, ...(agentId === undefined ? {} : { agentId }) })
      for (const index of [0, 1]) {
        const stream = $.turn.step({ turnId: id, index, model: 'claude-test', messageCount: 2, ...(agentId === undefined ? {} : { agentId }) })
        for await (const _ of stream) {
          // drain
        }
      }
      await $.turn.complete({
        answer: 'not read',
        durationMs: 1000,
        isAborted: false,
        turnId: id,
        reason: 'answer',
        ...(agentId === undefined ? {} : { agentId }),
      })
    },
  }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

async function bandText($: Engine): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(found => found.text).join('\n')
}

describe('formatting', () => {
  test('tokens, points and thresholds format as the spec shows', async () => {
    expect(formatTokens(142_318)).toBe('142k')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatPoints(0.04)).toBe('<0.1')
    expect(formatPoints(0)).toBe('<0.1')
    expect(formatPoints(1.25)).toBe('1.3')
    expect(parseThresholds('80, 95')).toEqual([80, 95])
    expect(parseThresholds('95,80%, x, 0, 120, 80')).toEqual([80, 95])
  })
})

describe('status line', () => {
  test('shows every segment in the spec format', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 142_000, fiveHour: 38.4, weekly: 60 })
    await w.measure($, { ctx: 142_000, fiveHour: 38.4, weekly: 61.2 })
    expect(w.shown.status).toBe('Ctx 142k (14%) · 5h 38% · Wk 61% · Chat 1.2 pts')
  })

  test('rule: no response yet shows Ctx pending', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { weekly: 10 })
    expect(w.shown.status?.startsWith('Ctx pending')).toBe(true)
  })

  test('rule: empty rateLimits hides the limit segments', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 20_000 })
    expect(w.shown.status).toBe('Ctx 20k (2%)')
  })

  test('rule: a change under 0.1 points shows <0.1', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 20_000, weekly: 40 })
    await w.measure($, { ctx: 21_000, weekly: 40.05 })
    expect(w.shown.status?.endsWith('Chat <0.1 pts')).toBe(true)
  })

  test('each segment can be turned off', { options: { showContext: false, showWeekly: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 20_000, fiveHour: 12, weekly: 40 })
    expect(w.shown.status).toBe('5h 12% · Chat <0.1 pts')
  })
})

describe('per-conversation budget', () => {
  test('rule: empty rateLimits starts the budget at the first reading', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000 })
    await w.measure($, { ctx: 12_000, weekly: 30 })
    await w.measure($, { ctx: 14_000, weekly: 30.5 })
    expect(w.shown.status?.endsWith('Chat 0.5 pts')).toBe(true)
  })

  test('warns at 80% by toast once, then a band at 100% once', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000, weekly: 50 })
    await w.measure($, { ctx: 10_000, weekly: 51.6 })
    await w.measure($, { ctx: 10_000, weekly: 51.7 })
    expect(w.shown.toasts.filter(text => text.includes('weekly budget'))).toHaveLength(1)
    expect(await bandText($)).not.toContain('budget')

    await w.measure($, { ctx: 10_000, weekly: 52.1 })
    expect(await bandText($)).toContain('past its 2.0-point budget')
    expect(w.shown.toasts.filter(text => text.includes('weekly budget'))).toHaveLength(1)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'dismiss-budget' })
    await ui.unmount()
    await w.measure($, { ctx: 10_000, weekly: 52.5 })
    expect(await bandText($)).not.toContain('budget')
  })

  test('rule: a budget of 0 turns budget warnings off (parallel conversations)', { options: { conversationBudget: 0 } }, async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000, weekly: 10 })
    await w.measure($, { ctx: 10_000, weekly: 30 })
    expect(w.shown.toasts).toHaveLength(0)
    expect(await bandText($)).not.toContain('budget')
    expect(w.shown.status?.endsWith('Chat 20.0 pts')).toBe(true)
  })

  test('rule: a weekly reset carries the pre-reset use and takes a new baseline', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000, weekly: 97 })
    await w.measure($, { ctx: 10_000, weekly: 98.2 })
    await w.measure($, { ctx: 10_000, weekly: 0.3 })
    await w.measure($, { ctx: 10_000, weekly: 0.6 })
    expect(w.shown.status?.endsWith('Chat 1.5 pts')).toBe(true)
  })

  test('rule: after a gap past the cache lifetime, a new baseline keeps the earlier total', async ($, on) => {
    const w = world(on)
    await start($)
    await w.turn($, 't1')
    await w.measure($, { ctx: 60_000, weekly: 20 })
    await w.turn($, 't2')
    await w.measure($, { ctx: 61_000, weekly: 21 })
    await w.clock.advance(61 * MIN)
    // Other conversations used 5 points during the gap.
    await w.turn($, 't3')
    await w.measure($, { ctx: 62_000, weekly: 26 })
    expect(w.shown.status?.endsWith('Chat 1.0 pts')).toBe(true)
    await w.turn($, 't4')
    await w.measure($, { ctx: 63_000, weekly: 26.4 })
    expect(w.shown.status?.endsWith('Chat 1.4 pts')).toBe(true)
  })

  test('rule: a reload keeps the baseline, the carried total and dismissals', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 200_000, weekly: 97 })
    await w.measure($, { ctx: 200_000, weekly: 98 })
    await w.measure($, { ctx: 200_000, weekly: 0.5 })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'dismiss-context' })
    await ui.unmount()

    // A reload runs register and session.start again; $.state stays.
    await start($)
    await w.measure($, { ctx: 201_000, weekly: 0.7 })
    expect(w.shown.status?.endsWith('Chat 1.2 pts')).toBe(true)
    expect(await bandText($)).not.toContain('Context is')
  })

  test('a /clear starts the conversation over', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000, weekly: 10 })
    await w.measure($, { ctx: 10_000, weekly: 11 })
    await $.session.end({ reason: 'clear' } as never)
    await w.measure($, { ctx: 1_000, weekly: 11 })
    expect(w.shown.status?.endsWith('Chat <0.1 pts')).toBe(true)
  })

  test('a /clear leaves the pilot log untouched', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000, fiveHour: 5, weekly: 10 })
    await w.turn($, 't1')
    await w.turn($, 't2')
    const before = JSON.stringify([...w.store.entries()])
    expect((w.store.get('turns:s1') as TurnRecord[]).length).toBe(2)

    await $.session.end({ reason: 'clear' } as never)
    expect(JSON.stringify([...w.store.entries()])).toBe(before)

    await w.turn($, 't3')
    expect((w.store.get('turns:s1') as TurnRecord[]).length).toBe(3)
    expect(w.store.has('kinds:s1')).toBe(true)
  })
})

describe('five-hour warning', () => {
  test('warns once per threshold crossing, and again after the window falls back', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000, fiveHour: 70 })
    await w.measure($, { ctx: 10_000, fiveHour: 81 })
    await w.measure($, { ctx: 10_000, fiveHour: 85 })
    await w.measure($, { ctx: 10_000, fiveHour: 96 })
    await w.measure($, { ctx: 10_000, fiveHour: 97 })
    expect(w.shown.toasts).toEqual([
      'Five-hour limit at 81%, past your 80% threshold.',
      'Five-hour limit at 96%, past your 95% threshold.',
    ])
    await w.measure($, { ctx: 10_000, fiveHour: 2 })
    await w.measure($, { ctx: 10_000, fiveHour: 80 })
    expect(w.shown.toasts).toHaveLength(3)
  })

  test('a missing reading never warns', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 10_000, fiveHour: 81 })
    await w.measure($, { ctx: 10_000 })
    await w.measure($, { ctx: 10_000, fiveHour: 82 })
    expect(w.shown.toasts).toHaveLength(1)
  })
})

describe('context-size warning', () => {
  test('shows a band once per crossing; dismissal holds until the next crossing', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 149_000 })
    expect(await bandText($)).not.toContain('Context is')
    await w.measure($, { ctx: 151_000 })
    expect(await bandText($)).toContain('Context is 151k tokens, past your 150k threshold')

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'dismiss-context' })
    await ui.unmount()
    await w.measure($, { ctx: 155_000 })
    expect(await bandText($)).not.toContain('Context is')

    await w.measure($, { ctx: 40_000 })
    await w.measure($, { ctx: 152_000 })
    expect(await bandText($)).toContain('Context is 152k')
  })

  test('rule: just compacted suppresses the context warning', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 151_000 })
    await w.measure($, {})
    expect(await bandText($)).not.toContain('Context is')
    expect(w.shown.status).toBe('Ctx pending')
  })

  test('the band draws on every surface', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 151_000 })
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ key: 'dismiss-context' }))?.type).toBe('Button')
      await ui.unmount()
    }
  })
})

describe('cold-cache warning', () => {
  test('warns after the idle gap passes the lifetime, and clears on the next message', async ($, on) => {
    const w = world(on)
    await start($)
    await w.turn($, 't1')
    await w.measure($, { ctx: 80_000 })
    await w.clock.advance(59 * MIN)
    expect(await bandText($)).not.toContain('cache lifetime')
    await w.clock.advance(2 * MIN)
    expect(await bandText($)).toContain('Idle past the 60-minute cache lifetime: your next message re-reads all 80k tokens')

    await $.turn.start({ text: 'not read', turnId: 't2' })
    expect(await bandText($)).not.toContain('cache lifetime')
  })

  test('a dismissal holds for that idle episode only', async ($, on) => {
    const w = world(on)
    await start($)
    await w.turn($, 't1')
    await w.measure($, { ctx: 80_000 })
    await w.clock.advance(61 * MIN)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'dismiss-cold' })
    await ui.unmount()
    expect(await bandText($)).not.toContain('cache lifetime')

    await w.turn($, 't2')
    await w.measure($, { ctx: 81_000 })
    await w.clock.advance(61 * MIN)
    expect(await bandText($)).toContain('cache lifetime')
  })

  test('rule: no warning below the minimum size, or while pending', async ($, on) => {
    const w = world(on)
    await start($)
    await w.turn($, 't1')
    await w.measure($, { ctx: 40_000 })
    await w.clock.advance(61 * MIN)
    expect(await bandText($)).not.toContain('cache lifetime')
    await w.measure($, {})
    expect(await bandText($)).not.toContain('cache lifetime')
  })

  test('rule: a plan window at 100% cuts the lifetime to 5 minutes and says so', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 80_000, fiveHour: 100, weekly: 60 })
    await w.turn($, 't1')
    await w.clock.advance(6 * MIN)
    const text = await bandText($)
    expect(text).toContain('Idle past the 5-minute cache lifetime')
    expect(text).toContain('usage credits are assumed')
  })

  test('rule: the cold-cache timer is re-armed after a reload', async ($, on) => {
    const w = world(on)
    await start($)
    await w.turn($, 't1')
    await w.measure($, { ctx: 80_000 })
    await start($)
    await w.clock.advance(61 * MIN)
    expect(await bandText($)).toContain('cache lifetime')
  })
})

describe('pilot log', () => {
  test('logs main-conversation turns only, with the first request and the last response', async ($, on) => {
    const w = world(on)
    await start($)
    w.setStep({ input: 12, cacheRead: 0, cacheWrite: 70_000 })
    await w.turn($, 't1')
    await w.turn($, 'sub', 'agent-1')
    await w.clock.advance(30 * MIN)
    w.setStep({ input: 3, cacheRead: 70_000, cacheWrite: 200 })
    await w.turn($, 't2')

    const records = w.store.get('turns:s1') as TurnRecord[]
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ g: null, m: 'claude-test', fi: 12, fr: 0, fw: 70_000, lr: 900, lw: 40, ac: 800_000 })
    expect(records[1]).toMatchObject({ g: 30 * MIN, fr: 70_000, fw: 200 })
  })

  test('marks the turns the Chat figure excludes, keeping their first-request counts', async ($, on) => {
    const w = world(on)
    await start($)
    // First turn: no baseline yet, so its use falls inside the baseline.
    w.setStep({ input: 11, cacheRead: 0, cacheWrite: 50_000 })
    await w.turn($, 't1')
    await w.measure($, { ctx: 50_000, weekly: 20 })
    // An ordinary turn is counted.
    w.setStep({ input: 2, cacheRead: 50_000, cacheWrite: 300 })
    await w.turn($, 't2')
    await w.measure($, { ctx: 51_000, weekly: 20.4 })
    // The first turn after a gap past the cache lifetime takes a new baseline.
    await w.clock.advance(61 * MIN)
    w.setStep({ input: 9, cacheRead: 0, cacheWrite: 51_000 })
    await w.turn($, 't3')
    await w.measure($, { ctx: 52_000, weekly: 23 })
    w.setStep({ input: 3, cacheRead: 51_000, cacheWrite: 200 })
    await w.turn($, 't4')

    const records = w.store.get('turns:s1') as TurnRecord[]
    expect(records.map(record => record.x)).toEqual([true, false, true, false])
    expect(records[0]).toMatchObject({ fi: 11, fr: 0, fw: 50_000 })
    expect(records[2]).toMatchObject({ g: 61 * MIN, fi: 9, fr: 0, fw: 51_000 })
    expect(toCsv(records).split('\n').map(row => row.split(',').pop())).toEqual(['chat_excluded', 'yes', 'no', 'yes', 'no'])
  })

  test('records every rate-limit kind seen', async ($, on) => {
    const w = world(on)
    await start($)
    await $.session.measure({
      context: { window: WINDOW },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 10 },
        { kind: 'seven_day', percentUsed: 20 },
        { kind: 'spend_limit', percentUsed: 5 },
      ],
      changed: ['rateLimits'],
    })
    expect(Object.keys(w.store.get('kinds:s1') as object).sort()).toEqual(['five_hour', 'seven_day', 'spend_limit'])
    expect(w.shown.toasts).toHaveLength(0)
  })

  test('caps the log at 14 days or 5,000 turns, whichever is smaller', async () => {
    const now = START
    const at = (t: number): TurnRecord => ({ t, g: null, m: null, fi: null, fr: null, fw: null, li: null, lr: null, lw: null, ac: null, ct: null })
    const old = [at(now - MAX_AGE_MS - 1), at(now - MAX_AGE_MS + 1)]
    expect(capRecords(old, now)).toHaveLength(1)
    const many = Array.from({ length: MAX_TURNS + 10 }, (_, i) => at(now - i))
    const kept = capRecords(many, now)
    expect(kept).toHaveLength(MAX_TURNS)
    expect(kept[kept.length - 1]?.t).toBe(now)
  })

  test('trims old turns across sessions at start, keeping kinds seen', async ($, on) => {
    const w = world(on)
    const stale = { t: START - MAX_AGE_MS - MIN, g: null, m: null, fi: null, fr: null, fw: null, li: null, lr: null, lw: null, ac: null, ct: null }
    w.store.set('turns:old', [stale])
    w.store.set('kinds:old', { seven_day: { f: 1, l: 2, p: 3 } })
    await start($)
    expect(w.store.has('turns:old')).toBe(false)
    expect(w.store.get('kinds:old')).toEqual({ seven_day: { f: 1, l: 2, p: 3 } })
    expect(w.shown.toasts).toHaveLength(0)
  })

  test('CSV has a header and one row per turn', async () => {
    const csv = toCsv([{ t: START, g: 90 * MIN, m: 'claude-test', fi: 1, fr: 2, fw: 3, li: 4, lr: 5, lw: 6, ac: null, ct: 7, x: true }])
    expect(csv.split('\n')).toEqual([
      'ended_at_utc,idle_gap_min,model,first_input,first_cache_read,first_cache_write,last_input,last_cache_read,last_cache_write,auto_compact_threshold,context_tokens,chat_excluded',
      '2026-10-26T00:00:00.000Z,90.0,claude-test,1,2,3,4,5,6,,7,yes',
    ])
  })

  test('the command opens the pane, which lists kinds and turns', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 1_000, fiveHour: 4, weekly: 9 })
    await w.turn($, 't1')
    const answer = await $.command.run({ command: 'usage-meter-log', args: '' } as never)
    expect(answer).toMatchObject({ text: 'Opened the Usage Meter log.' })

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /seven_day: 9%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Turns logged: 1/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Copy as CSV copies where it can and shows the CSV where it cannot', async ($, on) => {
    const w = world(on)
    await start($)
    await w.turn($, 't1')
    const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await term.press({ key: 'copy' })
    expect(w.shown.copies[0]?.startsWith('ended_at_utc,')).toBe(true)
    expect(await term.find({ type: 'Text', text: /Copied the log as CSV/ })).toBeDefined()
    await term.unmount()

    const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desk.press({ key: 'copy' })
    expect(await desk.find({ type: 'Code' })).toBeDefined()
    await desk.unmount()
  })

  test('Clear asks for confirmation, removes turns and keeps kinds seen', async ($, on) => {
    const w = world(on)
    await start($)
    await w.measure($, { ctx: 1_000, weekly: 9 })
    await w.turn($, 't1')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'clear' })
    expect(w.store.has('turns:s1')).toBe(true)
    expect((await ui.find({ key: 'clear' }))?.text).toContain('Confirm clear')
    await ui.press({ key: 'clear' })
    expect(w.store.has('turns:s1')).toBe(false)
    expect(w.store.has('kinds:s1')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Cleared 1 turns/ })).toBeDefined()
    await ui.unmount()
  })
})
