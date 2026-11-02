// opencode-sessions-sidebar — TUI part (v0.4)
//
// Sidebar section (rendered after the built-in Context/MCP contributions):
// every session from the last 7 days across ALL projects, newest first.
//
// Layout (spec 2026-10-27): two lines per session + a blank
// separator line between sessions.
//   line 1: the digest (session title, or the first user message) — theme
//           base at full brightness
//   line 2: the FULL session id, left-aligned with the digest — light gray
//           (muted blended toward the background + DIM), copy-pasteable
//           straight into sessions_read / sessions_rename
// The list is a fixed-height window (12 rows by default, SESSIONS_SIDEBAR_
// HEIGHT) that scrolls internally — it never measures the host's tree.
//
// Data     : bun:sqlite, read-only on opencode.db. The live table is
//            `session_v2`; `session` is the legacy v1 table (fallback).
// Refresh  : server session events (debounced) + 60s poll.
// Rendering: plain Solid/OpenTUI primitives from @opentui/solid (no JSX, so
//            the module loads even without the JSX transform) — the same
//            shape as a compiled .tsx component.
//
// Notes (hard-won, do not "simplify" these away)
//  - `process.env.HOME` is undefined on Windows; the DB path must fall back
//    to USERPROFILE / os.homedir() or every query silently returns nothing.
//  - `bun:sqlite` must be imported explicitly; a missing import used to be
//    swallowed by the try/catch and left the section empty (invisible).
//  - The live table is `session_v2`. `session` only holds v1 history, so a
//    query against `session` returns zero rows for the last 7 days.
//  - State lives in the host's own reactive store (context.storage.memory)
//    so the update path stays inside the host's reactive graph. A local
//    solid-js signal is only a fallback.
//  - Anything that throws must stay visible: the section renders an error
//    line instead of disappearing.
//  - The host's sidebar viewport is 42 columns wide minus padding (2 left +
//    2 right) and minus the 1 column the host reserves for its own
//    scrollbar => 37 usable columns.
//  - Text is clipped by DISPLAY WIDTH, not character count: a CJK glyph is
//    two columns, so a character-count clip overflows and the buffer then
//    cuts the line mid-glyph.
//  - Mixed colors on ONE text element: solid's setProp stringifies non-string
//    `content` values, so styled content is assigned directly on the
//    renderable (`body.content = new StyledText(chunks)`). Chunks carry fg as
//    a packed color `{ buffer: Uint16Array[r,g,b,a] }` (0..255 channels) — a
//    plain "#rrggbb" string throws inside encodeStyledText. Chunks without fg
//    inherit the element's own fg prop.

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import * as OpenTUI from "@opentui/core"
import * as OTSolid from "@opentui/solid"
import { createSignal } from "solid-js"

const { TextAttributes, StyledText } = OpenTUI
const { createElement, insertNode, setProp, effect } = OTSolid

const SECONDS = 1000

// Multi-machine support (v0.4): installs differ — terminal sizes, opencode
// versions, data locations — so every tunable has an env override. Defaults
// reproduce the verified layout; zero configuration is required.
//   SESSIONS_SIDEBAR_DAYS     lookback window in days              (7)
//   SESSIONS_SIDEBAR_MAX      max sessions queried                 (200)
//   SESSIONS_SIDEBAR_HEIGHT   visible list rows                    (12)
//   SESSIONS_SIDEBAR_WIDTH    clip budget in columns; pinning this
//                             also disables width auto-detection    (36/auto)
//   SESSIONS_SIDEBAR_DB       explicit opencode.db path (skips discovery)
function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? "", 10)
  return v > 0 ? v : fallback
}

const DAYS = envInt("SESSIONS_SIDEBAR_DAYS", 7)
const MAX_ROWS = envInt("SESSIONS_SIDEBAR_MAX", 200)
const REFRESH_MS = 60 * SECONDS
// Fixed geometry (v8): the section no longer measures the host's render
// tree — that walk never found the real viewport (the scrollbox viewport is
// not in the parent chain), produced wrong heights, and re-measured on every
// scroll, resizing the list mid-scroll and overlapping neighboring sections.
// The builtin contract: plain content-sized root box, one leaf scrollbox
// with an explicit height (scrollboxes clip; plain boxes do not).
const LIST_HEIGHT = envInt("SESSIONS_SIDEBAR_HEIGHT", 12)
// Sidebar 42 cols − root padding (2+2) − slot box paddingRight 1 − the
// scrollbox content paddingRight 1 = 36 usable text columns. Used until a
// real measurement arrives (see the width watch in buildSection); an
// explicit SESSIONS_SIDEBAR_WIDTH both sets it and pins it.
const WIDTH_PINNED = Number.parseInt(process.env["SESSIONS_SIDEBAR_WIDTH"] ?? "", 10)
const LIST_WIDTH = WIDTH_PINNED > 0 ? WIDTH_PINNED : 36

// ---------------------------------------------------------------- data layer

let db
let dbTable
// time_updated unit: opencode stores epoch milliseconds, but a DB written by
// an older build may hold unix seconds — comparing an ms cutoff against
// seconds silently empties (or freezes) the list. Detected once, by
// magnitude: any ms-epoch timestamp is >= ~10^12.
let dbTimeScale = 1
let lastError = ""

function dbCandidates() {
  const out = []
  // Explicit override first: unusual installs (portable, symlinked, or a
  // second opencode instance) may keep the DB anywhere.
  if (process.env.SESSIONS_SIDEBAR_DB) out.push(process.env.SESSIONS_SIDEBAR_DB)
  const homes = []
  if (process.env.HOME) homes.push(process.env.HOME)
  if (process.env.USERPROFILE) homes.push(process.env.USERPROFILE)
  try {
    const h = homedir()
    if (h) homes.push(h)
  } catch {}
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) out.push(`${xdg}/opencode/opencode.db`)
  for (const h of homes) out.push(`${h}/.local/share/opencode/opencode.db`)
  return out
}

function openDb() {
  if (db) return db
  const candidates = dbCandidates()
  const path = candidates.find((c) => existsSync(c))
  if (!path) {
    // Not a plugin failure: a machine where the TUI has never written its
    // DB yet (fresh install) legitimately has no file. Say what to do
    // instead of leaking a raw sqlite open error.
    throw new Error("no opencode.db (fresh install?) - set SESSIONS_SIDEBAR_DB")
  }
  db = new Database(path, { readonly: true })
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session')")
    .all()
    .map((r) => r.name)
  dbTable = names.includes("session_v2") ? "session_v2" : names.includes("session") ? "session" : "session_v2"
  try {
    const probe = db.prepare(`SELECT MAX(time_updated) AS m FROM ${dbTable}`).get()
    if (probe && Number(probe.m) > 0 && Number(probe.m) < 1e12) dbTimeScale = 1000
  } catch {}
  return db
}

// The digest is the session title. The host renders a placeholder
// ("New session - <iso>") for sessions without one, which says nothing in a
// digest column, so those sessions fall back to the first user message —
// that is what the session was actually about.
const FALLBACK_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/

function loadSessions() {
  try {
    const cutoff = (Date.now() - DAYS * 86400 * SECONDS) / dbTimeScale
    const conn = openDb()
    const rows = conn
      .prepare(
        `SELECT id, title, directory, time_updated, model
         FROM ${dbTable}
         WHERE parent_id IS NULL AND time_updated >= ?
         ORDER BY time_updated DESC
         LIMIT ${MAX_ROWS}`,
      )
      .all(cutoff)
    const counted = conn
      .prepare(`SELECT count(*) as c FROM ${dbTable} WHERE parent_id IS NULL AND time_updated >= ?`)
      .get(cutoff)
    const total = Number(counted?.c ?? rows.length)
    lastError = ""
    return { rows: withDigests(conn, rows), total }
  } catch (e) {
    lastError = String(e?.message ?? e).slice(0, 60)
    return { rows: [], total: 0 }
  }
}

// Sessions without a usable title get their digest from the first user
// message of the session. `session_message` holds the live message log
// (`message` is the empty v1 leftover); `seq` orders the messages.
function withDigests(conn, rows) {
  const need = rows.filter((r) => !r.title || FALLBACK_TITLE.test(r.title))
  if (!need.length) return rows
  const ids = need.map((r) => r.id)
  const holes = ids.map(() => "?").join(",")
  const digests = new Map()
  try {
    const picked = conn
      .prepare(
        `SELECT sm.session_id AS sid, sm.data AS data
         FROM session_message sm
         JOIN (
           SELECT session_id, MIN(seq) AS seq
           FROM session_message
           WHERE type = 'user' AND session_id IN (${holes})
           GROUP BY session_id
         ) f ON f.session_id = sm.session_id AND f.seq = sm.seq`,
      )
      .all(...ids)
    for (const row of picked) {
      try {
        const parsed = JSON.parse(row.data)
        const text = typeof parsed?.text === "string" ? parsed.text : ""
        if (text) digests.set(row.sid, text)
      } catch {}
    }
  } catch {
    // A missing digest is not fatal: the row still renders with its title.
  }
  return rows.map((row) => {
    const fallback = digests.get(row.id)
    if (!fallback) return row
    return { ...row, title: fallback }
  })
}

// ---------------------------------------------------------------- formatting

// Theme colors arrive in different shapes depending on the caller: the
// offline harness passes hex strings ("#808080"), the real host passes
// whatever its theme provider produces (observed: NOT a plain hex string —
// see HANDOFF). Normalize anything usable into the packed color a styled
// chunk needs ({ buffer: Uint16Array[r,g,b,a] }, channels 0..255):
//   - "#rgb" / "#rrggbb" strings
//   - already-packed objects (anything with a 4-length .buffer)
//   - { hex: "#..." } wrappers
// Anything else returns null and the caller must NOT put fg on the chunk:
// `fg: null` throws inside encodeStyledText (null.buffer) — only an absent
// fg inherits the element color.
function packedColor(color) {
  if (color == null) return null
  if (typeof color === "object") {
    const b = color.buffer
    if (b && typeof b.length === "number" && b.length >= 4) {
      const out = new Uint16Array(4)
      for (let i = 0; i < 4; i++) out[i] = Number(b[i]) || 0
      return { buffer: out }
    }
    if (typeof color.hex === "string") return packedColor(color.hex)
    return null
  }
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim())
  if (!m) return null
  const hex3 = m[1]
  const h = hex3.length === 3 ? [...hex3].map((c) => c + c).join("") : hex3
  const byte = (s) => parseInt(s, 16)
  return {
    buffer: new Uint16Array([byte(h.slice(0, 2)), byte(h.slice(2, 4)), byte(h.slice(4, 6)), 255]),
  }
}

// Last-resort digest: nothing in the title or the message log, so name the
// session after the project directory it belongs to.
function dirBasename(dir) {
  const parts = String(dir ?? "").split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ""
}

// Blend two packed colors: result = a*(1-t) + bg*t (per channel).
function blend(a, b, t) {
  const out = new Uint16Array(4)
  for (let i = 0; i < 4; i++) out[i] = Math.round((a.buffer[i] ?? 0) * (1 - t) + (b.buffer[i] ?? 0) * t)
  return { buffer: out }
}

// Display width in terminal columns. CJK glyphs occupy two columns, so a
// plain String.length clip would overflow the narrow sidebar and leave the
// buffer cutting the line mid-glyph. Ranges follow the usual East Asian
// Wide/Fullwidth sets.
function charWidth(code) {
  if (code < 0x1100) return 1
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals / punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana, CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe10 && code <= 0xfe19) || // vertical forms
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK ext B+
  )
    return 2
  return 1
}

function displayWidth(text) {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0))
  return width
}

// Clip to a column budget, appending an ASCII ellipsis when it does not
// fit. U+2026 is avoided on purpose: the OpenTUI text buffer renders it as
// the replacement character.
function clip(text, maxWidth) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!value) return ""
  if (displayWidth(value) <= maxWidth) return value
  const budget = Math.max(0, maxWidth - 3)
  let width = 0
  let out = ""
  for (const ch of value) {
    const w = charWidth(ch.codePointAt(0))
    if (width + w > budget) break
    out += ch
    width += w
  }
  return out + "..."
}

// Plain-string body (no colors): the last-resort fallback if styled content
// ever throws — the section must stay readable, never crash the slot.
function plainBody(rows, width) {
  const lines = []
  rows.forEach((row, i) => {
    const digest = row.title?.trim() || dirBasename(row.directory) || "(untitled)"
    lines.push(clip(digest, width), `${row.id}`)
    if (i < rows.length - 1) lines.push("")
  })
  return lines.join("\n")
}

// Styled body: per session a white digest line, then the full session id
// light gray on its own line, left-aligned, then a blank separator line
// (2026-10-27: no separator felt cramped once the digest went pure
// white — with strong group anchors the blank line reads as normal list
// spacing). All in ONE text element — the chunk array is rebuilt wholesale
// on every refresh, so the element tree itself never changes.
function buildBody(rows, width, digestStyle, idStyle) {
  const chunks = []
  const last = rows.length - 1
  for (let i = 0; i <= last; i++) {
    const row = rows[i]
    const digest = row.title?.trim() || dirBasename(row.directory) || "(untitled)"
    chunks.push({ __isChunk: true, text: `${clip(digest, width)}\n`, ...digestStyle })
    const tail = i === last ? "" : "\n"
    chunks.push({ __isChunk: true, text: `${row.id}${tail}`, ...idStyle })
    if (i !== last) chunks.push({ __isChunk: true, text: "\n" })
  }
  return new StyledText(chunks)
}

// ---------------------------------------------------------------- state

// The host's own store keeps the data inside the host's reactive graph, so
// updating it re-renders this section. A local signal is the fallback.
function createState(context, initial) {
  try {
    const [store, mutate] = context.storage.memory("sessions-sidebar", { initial: { data: initial } })
    return {
      get: () => store.data,
      set: (data) =>
        mutate((draft) => {
          draft.data = data
        }),
      patch: (fields) =>
        mutate((draft) => {
          Object.assign(draft.data, fields)
        }),
    }
  } catch {
    const [data, setData] = createSignal(initial)
    return {
      get: data,
      set: setData,
      patch: (fields) => setData((prev) => ({ ...prev, ...fields })),
    }
  }
}

// ---------------------------------------------------------------- rendering

let scrollBox
let stopWidthWatch = null

function buildSection(context, state) {
  const theme = context.theme ?? {}
  const fgBase = theme?.text?.base
  const fgMuted = theme?.text?.muted
  const fgError = theme?.text?.feedback?.error?.base ?? fgMuted

  // Visual hierarchy (accepted wording: "digest white, id light gray"):
  // terminals have ONE cell size (no font-size props on text renderables),
  // so the hierarchy is carried by color/brightness alone.
  //   header : bold, theme base
  //   digest : theme base, full brightness, no DIM   (pure white was "too
  //            white"; base reads as slightly gray and matches the host)
  //   id     : muted blended 35% toward the panel background + DIM
  // "fg: null" must never land on a chunk (crashes encodeStyledText);
  // an absent fg inherits the element color instead.
  const DIM = TextAttributes?.DIM ?? 0
  const digestStyle = {}
  const idStyle = { attributes: DIM }
  const mutedPacked = packedColor(fgMuted)
  const bgPacked = packedColor(theme?.background?.raised?.base)
  const idColor = mutedPacked && bgPacked ? blend(mutedPacked, bgPacked, 0.35) : mutedPacked
  if (idColor) idStyle.fg = idColor

  // Builtin contract (v8): the section root is a plain content-sized box —
  // no width/height/flexGrow/alignSelf (flexGrow is inert under the host's
  // unconstrained scroll content, and "100%" resolves against an undefined
  // parent height). Height lives ONLY on the leaf scrollbox, which clips.
  const root = createElement("box")

  const header = createElement("text")
  setProp(header, "fg", fgBase, undefined)
  if (TextAttributes) setProp(header, "attributes", TextAttributes.BOLD, undefined)
  insertNode(root, header)

  const list = createElement("scrollbox")
  // Fixed height on the scrollbox itself: scrollboxes clip to their
  // viewport, plain boxes do not — an unclipped list paints over the
  // sections below it.
  setProp(list, "height", LIST_HEIGHT, undefined)
  setProp(list, "focusable", true, undefined)
  // The host's own sidebar scrollbar is absolutely positioned so it never
  // steals a column; do the same here and reserve the column on the content
  // instead, so the text keeps its full width.
  setProp(
    list,
    "verticalScrollbarOptions",
    { position: "absolute", right: 0, top: 0, width: 1, showArrows: false },
    undefined,
  )
  setProp(list, "horizontalScrollbarOptions", { visible: false }, undefined)
  setProp(list, "contentOptions", { paddingRight: 1 }, undefined)
  insertNode(root, list)
  scrollBox = list

  const body = createElement("text")
  setProp(body, "fg", fgBase, undefined)
  // Never wrap: a wrapped line would break the strict per-session line
  // layout (digest / id / blank), so long digests are clipped by the caller.
  setProp(body, "wrapMode", "none", undefined)
  insertNode(list, body)

  const hint = createElement("text")
  setProp(hint, "fg", fgMuted, undefined)
  insertNode(root, hint)

  effect(() => {
    const data = state.get()
    const rows = data.rows ?? []
    const count = rows.length
    const total = data.total ?? count
    const width = data.width ?? LIST_WIDTH
    const scope = total > count ? `${count}/${total}` : `${count}`
    setProp(header, "content", `SESSIONS · ${DAYS}D (${scope})`, undefined)
    // solid's setProp stringifies non-string content, so the styled body is
    // assigned directly on the renderable. Encoding happens synchronously
    // inside the setter and CAN throw (bad color shape) — fall back to the
    // plain-string body so the slot never crashes.
    if (count) {
      try {
        body.content = buildBody(rows, width, digestStyle, idStyle)
      } catch {
        body.content = plainBody(rows, width)
      }
    } else {
      body.content = "(no sessions in the last 7 days)"
    }
    if (lastError) {
      setProp(hint, "fg", fgError, undefined)
      setProp(hint, "content", `db: ${lastError}`, undefined)
    } else {
      setProp(hint, "fg", fgMuted, undefined)
      setProp(hint, "content", count ? "ctrl+↑↓ / wheel to scroll" : "", undefined)
    }
  })

  // Geometry stays fixed (v8): the host tree is never measured for height.
  // v0.4 tracks exactly one dynamic value — the list's OWN computed width —
  // because another opencode version may size the sidebar differently. It
  // is read locally on our element (never by walking the parent chain,
  // which was the v7 bug), feeds only the clipping budget (never
  // geometry), and patches state solely when the value changes, so it
  // cannot feed back into layout. An explicit SESSIONS_SIDEBAR_WIDTH
  // disables the watch entirely.
  if (!(WIDTH_PINNED > 0) && !stopWidthWatch) {
    const measure = () => {
      const box = scrollBox
      if (!box) return
      try {
        const w = Math.floor(box.getComputedLayout?.()?.width ?? 0)
        // contentOptions paddingRight 1: one column is padding, not text
        const usable = w - 1
        if (usable >= 10 && state.get().width !== usable) state.patch({ width: usable })
      } catch {}
    }
    const stops = []
    const watch = (emitter, event) => {
      try {
        const off = emitter?.on?.(event, measure)
        if (typeof off === "function") stops.push(off)
      } catch {}
    }
    watch(context.renderer?.root, "layout-changed")
    watch(context.renderer, "resize")
    const probe = setTimeout(measure, 0)
    stops.push(() => clearTimeout(probe))
    stopWidthWatch = () => {
      for (const stop of stops) {
        try {
          stop()
        } catch {}
      }
      stops.length = 0
      stopWidthWatch = null
    }
  }

  return root
}

// ---------------------------------------------------------------- keymap

function scrollBy(delta) {
  const box = scrollBox
  if (!box) return
  try {
    if (typeof box.scrollBy === "function") box.scrollBy(delta)
    else if (typeof box.scrollTop === "number") box.scrollTop = Math.max(0, box.scrollTop + delta)
  } catch {}
}

function attachKeyScroll(context) {
  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: "sessions-sidebar.up",
        title: "Sessions: scroll up",
        group: "Sessions",
        bind: "ctrl+up",
        run: () => scrollBy(-2),
      },
      {
        id: "sessions-sidebar.down",
        title: "Sessions: scroll down",
        group: "Sessions",
        bind: "ctrl+down",
        run: () => scrollBy(2),
      },
    ],
  }))
}

// ---------------------------------------------------------------- plugin

export default {
  id: "sessions-sidebar",
  setup(context) {
    const initial = loadSessions()
    initial.width = LIST_WIDTH
    const state = createState(context, initial)

    let pending = null
    // patch (not set): a width detected between refreshes must survive them
    const applyRows = () => {
      const { rows, total } = loadSessions()
      state.patch({ rows, total })
    }
    const refresh = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        applyRows()
      }, 500)
    }

    const stops = []
    for (const type of ["session.created", "session.updated", "session.deleted", "session.idle"]) {
      try {
        stops.push(context.data.on(type, refresh))
      } catch {}
    }
    const timer = setInterval(applyRows, REFRESH_MS)

    attachKeyScroll(context)

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        try {
          return buildSection(context, state)
        } catch (e) {
          // never vanish silently: show the failure in place
          const err = createElement("text")
          setProp(err, "fg", "#ff5555", undefined)
          setProp(err, "content", `sessions-sidebar: ${String(e?.message ?? e).slice(0, 70)}`, undefined)
          return err
        }
      },
    })

    return () => {
      clearInterval(timer)
      if (pending) clearTimeout(pending)
      try {
        stopWidthWatch?.()
      } catch {}
      for (const stop of stops) {
        try {
          stop?.()
        } catch {}
      }
      try {
        unregister?.()
      } catch {}
    }
  },
}
