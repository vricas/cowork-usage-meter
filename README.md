# Cowork Usage Meter

An independent plugin, not an Anthropic product. It shows each conversation's context size and your plan-limit use in the status line, and warns at budgets you set, so heavy users can manage their weekly allowance by measurement rather than by feel.

Version 0.1.0 is a pilot release.

## Install

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `vricas/cowork-usage-meter`, then Add plugin.

At the prompt of a terminal session:

```
/plugin install cowork-usage-meter --marketplace vricas/cowork-usage-meter
```

From a shell:

```
claude plugin install cowork-usage-meter --marketplace vricas/cowork-usage-meter
```

Answer `y` to add the marketplace, then choose a scope. A settings screen follows.

## What it shows

- **Status line:** `Ctx 142k (14%) · 5h 38% · Wk 61% · Chat 1.2 pts`, refreshed after every turn. `Chat` is the points of the weekly limit this conversation has used, excluding its first turn and the first turn after a long idle gap.
- **Per-conversation budget:** a toast at 80% of the budget, then a band above the prompt at 100%.
- **Five-hour warning:** a toast as the five-hour window passes each threshold, once per crossing.
- **Context-size warning:** a band suggesting a fresh conversation with a handoff note.
- **Cold-cache warning:** a band once the conversation has been idle past the cache lifetime, because the next message re-reads the whole conversation at the full rate.
- **Pilot log:** `/usage-meter-log` opens a pane listing every rate-limit kind seen and each turn's cache counts, with Copy as CSV and Clear.

Bands stay while their condition holds and have a Dismiss button; a dismissal lasts until the next crossing.

## Settings

| Setting | Default | Note |
| --- | --- | --- |
| Per-conversation budget | 2.0 points | 0 turns budget warnings off; turn off the Chat segment to hide the figure too |
| Five-hour thresholds | 80, 95 | Comma-separated percentages |
| Context-size threshold | 150,000 tokens | Below the smallest 200,000-token window |
| Cache lifetime | 60 minutes | Falls to 5 minutes while a plan window reads 100% |
| Cold-cache minimum size | 50,000 tokens | Smaller conversations are cheap to re-read |
| Status line segments | All on | Context, five-hour, weekly and Chat, each switchable |

The defaults are assumptions to validate during the pilot, not measured optima.

## Known gaps

- No Fable-specific figure: the platform reports only five-hour, seven-day and gateway spend-limit windows.
- Limit percentages are account-wide, so parallel conversations share them and the Chat figure is approximate.
- The Chat figure excludes a conversation's first turn and the first turn after a long idle gap, because the budget takes its baseline from the reading that follows each. The pilot log marks those turns (`chat_excluded` in the CSV) and keeps their first-request token counts, so the pilot can measure what the figure misses.
- Figures are pending until the first response, and again just after a compaction.

## Privacy

The meter reads token counts, limit percentages, reset times and timestamps. It never reads messages, files or tool output, makes no network calls and no model calls, and sends nothing anywhere. One conversation's figures live in session state. The pilot log keeps counts and timestamps, never content, in the plugin's local store for 14 days or 5,000 turns, whichever is smaller; Clear in the log pane removes it.

## Licence

MIT. See [LICENSE](LICENSE).
