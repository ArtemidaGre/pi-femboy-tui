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
  or flip toggles itself (and says so with a toast, so a vibe change never
  happens behind your back)
- **femboy-mcp pairing** — point `femboy.mcp.url` at a running
  [`pi-femboy-mcp`](../femboy-mcp) server and every window shares one outfit,
  one headpat counter and one set of feature flags; offline degrades to the
  old purely-local vibe with zero drama
- **talking chibi** — while the LLM streams an assistant message, up to a
  dozen wrapped lines of its words appear as a **speech column to the left of
  the chibi**, joined by a dashed rail whose `▸` tail points into her mouth;
  the sprite lip-syncs (`ω` ↔ `▽` every tick) while the head *slaps a cell
  down every other open mouth* and sways on the third bar — a 4-beat puppet
  cadence that rests whenever the stream pauses after punctuation. The frame
  breathes wider for the column and deflates back to sprite width ~8 s after
  the message lands. The transcript itself is untouched — display-only, fed
  from the markdown transformer, zero extra inference

Everything is driven by one store (`extensions/vibe.ts`): components read it at render
time and subscribe for repaints, so a toggle lands on the next frame without
rebuilding the editor — and flipping the ribbon never loses your draft. An
idle session runs no timers at all (a *paired* session keeps one MCP notification
stream open — that's the point).

Nothing pastel is allowed to break pi: the markdown transformer, the header,
both bars, the editor ribbon, every tool row, the chibi and the closet guard
their own rendering. On a hiccup they log to the debug console and hand back a
plain line (`♡ pastel bar hiccuped`) — the transcript, your draft, and pi's
input pump keep working. `npm run check` proves it by injecting faults.

## Install

As a pi package (recommended) — points pi straight at this working tree:

```sh
pi install ./path/to/pi-femboy-tui     # local dev, loads extensions/index.ts + themes/femboy.json
pi install git:github.com/ArtemidaGre/pi-femboy-tui
```

Or drop the files into pi's resource directories yourself:

```sh
git clone git@github.com:ArtemidaGre/pi-femboy-tui.git
cp -r pi-femboy-tui/extensions ~/.pi/agent/extensions/femboy
cp pi-femboy-tui/themes/femboy.json ~/.pi/agent/themes/
```

(One source of truth, please: if you `pi install` the package, delete the
hand-copied `~/.pi/agent/extensions/femboy` — two copies of ten files load as
ten separate extension entries.)

Then restart pi (or `/reload`). The chrome colours come from theme tokens, so
it works with **any** theme; the bundled `themes/femboy.json` is the matching
pastel palette:

```sh
pi --use-theme femboy   # or /settings → Theme
```

## Development

```sh
npm install          # pi's packages + typescript as devDependencies (peer, never bundled)
npm run typecheck    # tsc --noEmit, strict + noUnusedLocals + noUncheckedIndexedAccess
npm run check        # offline smoke tests: real pi loader, no TUI, no model call
npm run check -- --show   # …and print a sample panel / chibi / closet
```

`tools/check.sh` runs three harnesses:

- `link-check.mjs` — every named import must resolve to a *real runtime export*
  (type-checking through jiti would not catch `import { homedir } from "node:path"`)
- `render-check.mjs` — widths 24…220 × four outfits × every bar, the tool-row
  resolver composing with pi's own renderers, uwu protecting code spans, the
  closet surviving every key, the speech frame breathing open and deflating on
  hold/stall expiry, and fault injection proving each pastel renderer degrades
  to an apology line instead of throwing.
- `pairing-check.mjs` — spawns the real femboy-mcp server from `../femboy-mcp/dist`
  and proves the pairing contract end-to-end: both sync directions, gated-skin
  refusals, self-paint after a push, and a SIGKILLed server degrading to local
  mode without a throw (skips gracefully when the server repo isn't built).

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
count — and when paired, the shared server state wins on top of all of that.

### Pairing with femboy-mcp

```json
{
  "femboy": {
    "mcp": {
      "url": "http://127.0.0.1:7413/mcp",
      "enabled": true,
      "secretEnvVar": "FEMBOY_SECRET"
    }
  }
}
```

With a live [`pi-femboy-mcp`](../femboy-mcp) HTTP server: outfit, feature
flags and the headpat counter sync across every paired window (`femboy://state`
+ `femboy://mood` subscriptions paint the vibe; local changes push back through
`femboy_set_outfit` / `femboy_toggle_feature`), a status bar badge `♡mcp` marks
it, and gated skins are refused by the server, not painted. No server, wrong
url, `enabled:false` — the chrome stays exactly as it was: local mode, silent.
The connector is a hand-rolled streamable-HTTP MCP client (`extensions/mcp.ts`):
no new dependencies, every socket path guarded, reconnect with backoff.

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
| `extensions/index.ts` | extension entry: commands, shortcut, tool, wiring |
| `extensions/vibe.ts` | single source of truth for pastel state + settings reader |
| `extensions/mcp.ts` | hand-rolled streamable-HTTP MCP client (pairing transport) |
| `extensions/pairing.ts` | femboy-mcp connector: shared state ↔ vibe, push/paint, offline fallback |
| `extensions/chrome.ts` | slot takeover: welcome, status bar, metrics, footer, editor |
| `extensions/companion.ts` | chibi dock on the right |
| `extensions/speech.ts` | the chibi's live speech store (fed by the markdown transformer) |
| `extensions/overlay.ts` | the `/femboy` closet overlay |
| `extensions/sprites.ts` | outfit sprite definitions |
| `extensions/tool-rows.ts` | pastel tool rows via `registerToolRenderer()` resolver |
| `extensions/uwu.ts` | display-only uwu markdown transformer |
| `extensions/palette.ts` | glyphs and pastel colour helpers |
| `package.json` | pi-package manifest: `pi.extensions` + `pi.themes`, host packages as peers |
| `tsconfig.json` | strict typecheck config (Bundler resolution: jiti loads `.ts` by path) |
| `themes/femboy.json` | matching pastel theme (bundled with the package) |
| `tools/check.sh` | offline harness: link check + render/fault checks |

Tool rows use pi 1.4.0's renderer *resolver*: execution is never wrapped, and
`next()` composes our summary line with pi's own expanded rendering (diffs,
line numbers, syntax highlighting).

---

made with ♡ — headpats included
