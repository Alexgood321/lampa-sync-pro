# Episode status v2 (Sync Pro 0.1.17 + NUM Series Pro 2.0.9)

## Scope

Torrent / native Lampac only. The HDRezka plugin, Netlify bridge, CUB, Trakt and
ARST113 are not modified.

## Single source of truth

Supabase `public.lsp_watch_state` remains canonical, keyed by
`user_id + media_key + episode_key`. The additive `completion_basis` column
supplies the origin of a completed mark.

- `none`: not completed, started, or manually reset.
- `inferred`: next consecutive episode actually started in an untracked external
  player. No fabricated timecode is stored.
- `playback`: native player delivered a completion event (90% or ended).
- `manual`: explicit `markEpisode(card, episode, true)` from NUM.
- `legacy`: already completed before this migration, provenance unavailable.

A `marked_complete` event carries
`completion_basis: 'inferred' | 'manual'` (legacy events without the field
remain manual). An automatic start of the next *consecutive* episode calls
`markEpisode(..., true, 'inferred')`. The server validates this field and
records it in the event audit. Existing event types and RPC endpoints remain
compatible. Supabase Realtime sends only a revision notification.

Do not infer the completion of skipped episodes or different seasons/series.
A manual reset takes precedence over the auto-next heuristic.
Once completed, an ordinary `started`/progress event does not remove the mark.

## NUM controls

- Green filled check / solid stripe: playback/manual/legacy completed.
- Green outline / muted stripe: inferred completed.
- Amber play indicator / stripe: a confirmed start with no completion.
- Neutral empty circle: unwatched.
- On touch: tap the circular status indicator next to a series title.
- On TV: long OK / context menu on a file to mark/unmark **one** episode.
- Bulk season actions and undo remain available in the `...` season menu.
- Duplicate torrent files for a single canonical episode receive the same
  status; their local Timeline rows are updated together.
- Status priority: cloud explicit reset, cloud completed, cloud in progress,
  then native Timeline at the unified 90% threshold.

Counters treat `manual`, `playback`, `legacy`, `inferred` as watched.
The in-progress series is excluded, so a zero-timecode `started` is not
incorrectly green.

## Compatibility and rollback

Previous Sync Pro: `0.1.16` (commit `e2cee5b8260433b69ddc799f627bf45b01a48d67`).
Previous NUM: `2.0.8` (commit `d95bbd6fd65eebaaed987b58549b6eedc70a0d0f`).
The original NUM script is archived as `num_series_v2_0_8.js`.

For rollback, reinstall these pinned versions. Existing `completion_basis`
data is harmless for old clients. If reverting the database writer is needed,
use `supabase/rollback/completion_basis_rollback.sql` after reviewing newer
data. Do **not** drop the additive column.

## Validation

- GitHub Actions: Sync Pro `tests/auto_episode_complete_smoke.js` and its
  other regression tests; NUM `tests/num-series-smoke.cjs`.
- Server test: `tests/completion_basis_sql_smoke.sql`, transaction + rollback.
- Manual E2E acceptance still required on iOS, macOS and Android TV.
