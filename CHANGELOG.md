# Changelog

## 0.1.0 (pilot)

First pilot release, built against plugin engine 2.1.310.

- Status line: context tokens and percentage, five-hour and weekly limit use, and the points of the weekly limit this conversation has used; each segment can be turned off.
- Per-conversation budget: a toast at 80% of the budget and a band above the prompt at 100%; a budget of 0 turns these warnings off.
- Five-hour warning: a toast at each threshold, once per crossing.
- Context-size warning: a band suggesting a fresh conversation with a handoff note.
- Cold-cache warning: a band once the conversation has been idle past the cache lifetime (5 minutes while a plan window reads 100%).
- Pilot log: `/usage-meter-log` opens a pane listing every rate-limit kind seen and, per turn, the first request's and last response's cache counts; copy as CSV or clear. Each turn is marked when the Chat figure excludes it (a first turn, or the first after a long idle gap). Counts and timestamps only, kept for 14 days or 5,000 turns, whichever is smaller.
