# extensions/

pi loads this package as **one** extension: `package.json` →
`pi.extensions: ["./extensions/index.ts"]`. The other nine files are plain
modules that `index.ts` imports — they are *not* entry points, so pi does not
execute them separately.

- `index.ts` — wiring: commands, shortcut, `femboy_vibe` tool, session lifecycle
- `vibe.ts` — the single state store + `settings.json` reader
- `chrome.ts` — slot takeover: welcome header, status bar, metrics bar, editor
  ribbon, blank footer (kept only for `footerData`), loader
- `companion.ts` — the chibi dock on the right (+ `speech.ts`, its live text)
- `overlay.ts` — the interactive `/femboy` closet
- `sprites.ts`, `palette.ts` — pixel grids, outfit palettes, glyphs, gradients
- `tool-rows.ts` — pastel tool rows through pi's renderer *resolver*
- `uwu.ts` — display-only markdown transformer, protects code and paths

Style rules that keep this place tidy:

1. **Read state at render time.** Components call `getVibe()` inside `render()`
   and subscribe with `onVibeChange()`; never cache palette values in fields,
   never rebuild a component to flip a toggle (that is how drafts die).
2. **No timers outside the animated overlays.** The closet (120 ms) and the
   chibi (250 ms) own the only intervals, both `unref()`d, both guarded.
   Everything else repaints on events.
3. **Measure, don't assume.** `visibleWidth` / `truncateToWidth` for every cell
   count; no Nerd Font glyphs; every `render()` returns lines that fit `width`.
4. **Fail soft.** Any decoration that throws must return one honest fallback
   line and `console.debug` the error — see `__testing` in `chrome.ts` and the
   fault-injection block in `tools/render-check.mjs`.
5. **Host packages are peers.** `@earendil-works/*` and `typebox` are provided
   by pi at runtime; they are devDependencies only so `npm run typecheck` and
   the harness can see them. Never move them to `dependencies`.
