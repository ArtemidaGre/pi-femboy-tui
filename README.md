# pi-femboy-tui ♡

A pastel chrome extension for [pi](https://github.com/earendil-works/pi) — one
extension that takes over pi's whole terminal UI and makes it *soft*.

```
✿ femboy · Gothic Mochi · headpats 8 · mood warming up · uwu on
```

## What it does

| Slot | Taken over by |
|---|---|
| welcome panel | pastel header with vibe summary |
| right dock | animated chibi companion (`companion.ts`) — speaks the model's live words in a speech bubble (`speech.ts`) |
| status bar | outfit · headpats · mood · toggles |
| editor | ribbon shell around pi's `CustomEditor` |
| metrics bar / footer | pastel variants |
| tool calls | blossom-prefixed summary rows (`tool-rows.ts`) |
| streaming loader | pastel spinner |

Plus:

- **`/femboy`** — interactive closet overlay: pick an outfit, toggle pastel,
  uwu transcript, tool rows, editor ribbon, companion (animated chibi preview)
- **`ctrl+alt+f`** — open the closet from anywhere
- **`/uwu`** — toggle the uwu transcript (display-only markdown transformer;
  file paths and commands are never uwuified)
- **`/femboy-off`** — hand every slot back to pi instantly
- **`femboy_vibe` tool** — the model can check the vibe, hand you a headpat,
  or flip toggles itself
- **talking chibi** — while the LLM streams an assistant message, its words
  render as subtitles in the companion's bubble; the sprite lip-syncs (`ω` ↔
  `▽` every tick) while the head *slaps a cell down every other open mouth*
  and sways on the third bar — a 4-beat puppet cadence that rests whenever
  the stream pauses after punctuation. The frame breathes wider for the
  sentence and deflates back to sprite width ~8 s after the message lands.
  The transcript itself is untouched — display-only, fed from the markdown
  transformer, zero extra inference

Everything is driven by one store (`vibe.ts`): components read it at render
time and subscribe for repaints, so a toggle lands on the next frame without
rebuilding the editor — and flipping the ribbon never loses your draft. An
idle session runs no timers at all.

## Install

Drop the extension into pi's extensions directory:

```sh
git clone git@github.com:ArtemidaGre/pi-femboy-tui.git ~/.pi/agent/extensions/femboy
```

Then restart pi (or `/reload`). The chrome colours come from theme tokens, so
it works with **any** theme — but a matching pastel theme (`femboy.json`) can
be dropped into `~/.pi/agent/themes/` and selected with:

```sh
pi --use-theme femboy   # or /settings → Theme
```

## Config

The `femboy` key in `settings.json` (project overrides user):

```json
{
  "femboy": {
    "pastel": true,
    "uwu": false,
    "welcome": "header",
    "outfit": "Oversized Hoodie",
    "toolRows": true,
    "ribbonEditor": true,
    "companion": true
  }
}
```

Layering (later wins): defaults → `settings.json` → the newest `femboy-tui`
custom entry in the session, so `/reload`, resume and fork keep your headpat
count.

## Outfits

- Pastel Sailor
- Oversized Hoodie
- Gothic Mochi
- Sporty Bling

Each outfit has its own chibi sprite set (`sprites.ts`) shown in the companion
dock and the closet overlay.

## Files

| File | Purpose |
|---|---|
| `index.ts` | extension entry: commands, shortcut, tool, wiring |
| `vibe.ts` | single source of truth for pastel state + settings reader |
| `chrome.ts` | slot takeover: welcome, status bar, metrics, footer, editor |
| `companion.ts` | chibi dock on the right |
| `overlay.ts` | the `/femboy` closet overlay |
| `sprites.ts` | outfit sprite definitions |
| `tool-rows.ts` | pastel tool rows via `registerToolRenderer()` resolver |
| `uwu.ts` | display-only uwu markdown transformer |
| `palette.ts` | glyphs and pastel colour helpers |

Tool rows use pi 1.4.0's renderer *resolver*: execution is never wrapped, and
`next()` composes our summary line with pi's own expanded rendering (diffs,
line numbers, syntax highlighting).

---

made with ♡ — headpats included
