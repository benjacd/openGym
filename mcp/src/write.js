/* Write tools (Phase 2, minimal). They never touch state-<uid>.json directly: every write is a
   GET /api/data → change → PUT /api/data with `baseRev`, the same path the app's own devices use.
   The server stamps what an API client changed (api/sync-stamps.js), so a phone that edited
   something meanwhile is merged instead of overwritten, and a write over a document this client
   never saw is refused with a 409 — answered here by re-reading and re-applying, a few times.

   Auth: instead of a long-lived token file, the server signs a short-lived session for the
   profile with the instance secret it already keeps in ./data (the same folder this server reads
   state from, so it adds no access it did not have). The token lives 5 minutes and is never
   written anywhere.

   Every tool previews by default: `apply: true` is what actually writes. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { dataDir, getUser } from './state.js'
import { exOr, EXIDX, BODYPARTS } from '../../frontend/src/lib/exercises.js'
import { MUSCLES, exerciseMuscleSnapshot } from '../../frontend/src/lib/muscles.js'
import { POLICIES_FOR } from '../../frontend/src/lib/progression.js'

export const apiBase = () => (process.env.OPENGYM_URL || 'http://localhost:8080').replace(/\/+$/, '')
const TOKEN_TTL_MS = 5 * 60 * 1000
const MAX_TRIES = 3

/* ---------- auth ---------- */

// Mirrors api/server.js makeSession(): `<uid>:<exp>:<sv>:<kind>` + '.' + HMAC-SHA256(base64url).
// Kind 'c' (a cookie-style token) because only kind 'b' tokens are ever renewed by GET /api/me.
export function mintToken({ uid, secret, sv = 0, now = Date.now(), ttl = TOKEN_TTL_MS }) {
  const payload = `${uid}:${now + ttl}:${sv}:c`
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return payload + '.' + mac
}

function tokenForProfile() {
  const dir = dataDir()
  const uid = getUser().id
  let secret, db
  try { secret = fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim() } catch (e) {
    throw codeErr('EAUTH', `cannot read the instance secret in the data folder (${e.code || e.message}) — the write tools sign their session with it`)
  }
  try { db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')) } catch { db = { users: [] } }
  const user = (db.users || []).find(u => u.id === uid)
  return mintToken({ uid, secret, sv: user?.sv || 0 })
}

function codeErr(code, msg) { const e = new Error(msg); e.code = code; return e }

/* ---------- API round-trip ---------- */

async function api(method, route, body, fetchImpl = globalThis.fetch) {
  const token = tokenForProfile()   // outside the try: a missing secret is not "unreachable"
  let res
  try {
    res = await fetchImpl(apiBase() + route, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    throw codeErr('EUNREACHABLE', `openGym is not reachable at ${apiBase()} (${e.cause?.code || e.message}) — start the server (docker compose up) or set OPENGYM_URL`)
  }
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

/* Read, change, write; on a 409 the change is re-applied to the document the server sent back.
   `change(state)` mutates its argument and returns a summary (or throws a validation error). */
export async function commit(change, { apply = false, fetchImpl } = {}) {
  let got = await api('GET', '/api/data', null, fetchImpl)
  if (got.status === 401) throw codeErr('EAUTH', 'openGym refused the session (401) — is OPENGYM_DATA the same data folder the running server uses?')
  if (got.status !== 200 || !got.data?.state) throw codeErr('EAPI', `GET /api/data answered ${got.status}`)
  let state = got.data.state, rev = got.data.rev
  for (let i = 0; i < MAX_TRIES; i++) {
    const next = structuredClone(state)
    const summary = change(next)
    if (!apply) return { applied: false, preview: true, note: 'nothing was written — call again with apply: true to save', ...summary }
    const body = { state: next, baseRev: rev }
    if (typeof state._wid === 'string') body.baseWid = state._wid
    const put = await api('PUT', '/api/data', body, fetchImpl)
    if (put.status === 200) return { applied: true, rev: put.data?.rev ?? null, ...summary }
    if (put.status === 409 && put.data?.state) { state = put.data.state; rev = put.data.rev; continue }
    throw codeErr('EAPI', `PUT /api/data answered ${put.status}${put.data?.error ? ': ' + put.data.error : ''}`)
  }
  throw codeErr('ECONFLICT', `the profile kept changing on another device; gave up after ${MAX_TRIES} tries — nothing was written`)
}

/* ---------- pure changes (exported for tests) ---------- */

const known = (id, S) => (S.customEx || []).some(c => c.id === id) || !!EXIDX[id]
const nameOf = (id, S) => ((S.customEx || []).find(c => c.id === id) || exOr(id))?.n || String(id)
const modeOfEntry = e => e.mode || 'reps'

// Tool field names → stored routine-entry keys (the shape api/coach/core/schemas.js EX_SCHEMA writes).
const FIELD = { sets: 'sets', reps: 'reps', reps_min: 'repsMin', weight: 'weight', rest_sec: 'restSec', progression: 'prog', increment: 'inc', sec: 'sec', mode: 'mode' }

function checkFields(f, mode) {
  const bad = (k, why) => { throw codeErr('EINVAL', `${k}: ${why}`) }
  const int = (k, lo, hi) => { if (f[k] != null && !(Number.isInteger(f[k]) && f[k] >= lo && f[k] <= hi)) bad(k, `whole number ${lo}–${hi}`) }
  int('sets', 1, 20); int('reps', 1, 100); int('reps_min', 1, 100); int('rest_sec', 0, 900); int('sec', 1, 3600)
  if (f.weight != null && !(typeof f.weight === 'number' && f.weight >= 0 && f.weight <= 1000)) bad('weight', '0–1000, or null to clear it')
  if (f.increment != null && !(typeof f.increment === 'number' && f.increment > 0 && f.increment <= 50)) bad('increment', 'more than 0, at most 50')
  if (f.mode != null && !['reps', 'time', 'cardio'].includes(f.mode)) bad('mode', 'reps, time or cardio')
  if (f.progression != null && !(POLICIES_FOR[mode] || ['off']).includes(f.progression)) bad('progression', `for ${mode} mode one of ${(POLICIES_FOR[mode] || ['off']).join(', ')}`)
}

function setFields(e, f) {
  for (const [k, v] of Object.entries(f)) {
    if (!(k in FIELD) || v === undefined) continue
    if (v === null) delete e[FIELD[k]]
    else e[FIELD[k]] = v
  }
  if (e.repsMin != null && e.reps != null && e.repsMin > e.reps) throw codeErr('EINVAL', `reps_min (${e.repsMin}) is above reps (${e.reps})`)
}

// Exercise address inside a routine: a 1-based position, or an exercise id that appears once.
function indexOf(r, { position, exercise_id }, S) {
  if (position != null) {
    if (!(Number.isInteger(position) && position >= 1 && position <= r.ex.length)) throw codeErr('EINVAL', `position ${position} is outside 1–${r.ex.length}`)
    if (exercise_id != null && r.ex[position - 1].id !== exercise_id) throw codeErr('EINVAL', `position ${position} holds ${nameOf(r.ex[position - 1].id, S)}, not ${exercise_id}`)
    return position - 1
  }
  const hits = r.ex.map((e, i) => (e.id === exercise_id ? i : -1)).filter(i => i >= 0)
  if (!hits.length) throw codeErr('EINVAL', `exercise ${exercise_id} is not in routine "${r.name}"`)
  if (hits.length > 1) throw codeErr('EINVAL', `exercise ${exercise_id} appears ${hits.length} times in "${r.name}" — address it by position`)
  return hits[0]
}

const view = (e, S) => e && ({ exercise: nameOf(e.id, S), id: e.id, sets: e.sets, mode: modeOfEntry(e), reps: e.reps, reps_min: e.repsMin, sec: e.sec, weight: e.weight, rest_sec: e.restSec, progression: e.prog, increment: e.inc, ...(e.sg ? { superset: e.sg, superset_rest_sec: e.sgRest, superset_name: e.sgName } : {}) })

/* Supersets, in the app's own shape (frontend/src/views/RoutineEdit.jsx, lib/superset-meta.js):
   neighbouring exercises share `sg` ('sg' + id), and every member carries the group's `sgName`
   and `sgRest` (rest between rounds). A group is one contiguous run of 2+ exercises. */
const newSg = () => 'sg' + crypto.randomBytes(6).toString('hex')
function dropSg(e) { delete e.sg; delete e.sgName; delete e.sgRest }
// After any edit: a group split by a move keeps only its first contiguous run, and a group left
// with a single member is no superset at all.
export function cleanupSupersets(ex) {
  const seen = new Set()
  for (let i = 0; i < ex.length; i++) {
    const g = ex[i].sg
    if (!g) continue
    if (seen.has(g)) { dropSg(ex[i]); continue }
    let j = i
    while (j + 1 < ex.length && ex[j + 1].sg === g) j++
    if (j === i) dropSg(ex[i])
    seen.add(g); i = j
  }
  return ex
}
function linkSuperset(r, positions, { rest_sec, name }) {
  const idx = [...new Set(positions || [])].sort((a, b) => a - b)
  if (idx.length < 2) throw codeErr('EINVAL', 'superset: give at least two positions')
  for (const p of idx) if (!(Number.isInteger(p) && p >= 1 && p <= r.ex.length)) throw codeErr('EINVAL', `superset: position ${p} is outside 1–${r.ex.length}`)
  for (let k = 1; k < idx.length; k++) if (idx[k] !== idx[k - 1] + 1) throw codeErr('EINVAL', 'superset: the exercises must be next to each other — move them first')
  if (rest_sec != null && !(Number.isInteger(rest_sec) && rest_sec >= 0 && rest_sec <= 900)) throw codeErr('EINVAL', 'superset rest_sec: whole number 0–900')
  const members = idx.map(p => r.ex[p - 1])
  // Leaving an old group: what remains of it is cleaned up afterwards.
  const sg = newSg(), label = name != null ? String(name).trim().slice(0, 40) : ''
  for (const e of members) { dropSg(e); e.sg = sg; if (label) e.sgName = label; if (rest_sec > 0) e.sgRest = rest_sec }
  return sg
}

export function editRoutine(S, { routine_id, rename, ops = [] }) {
  const r = (S.routines || []).find(x => x.id === routine_id)
  if (!r) throw codeErr('EINVAL', `no routine with id ${routine_id} — see list_routines`)
  r.ex = Array.isArray(r.ex) ? r.ex : []
  const changes = []
  if (rename != null) { const s = String(rename).trim(); if (!s) throw codeErr('EINVAL', 'rename: empty name'); changes.push({ op: 'rename', before: r.name, after: s }); r.name = s }
  for (const op of ops) {
    if (op.op === 'update') {
      const i = indexOf(r, op, S); const before = view(r.ex[i], S)
      const mode = op.set?.mode || modeOfEntry(r.ex[i]); checkFields(op.set || {}, mode)
      setFields(r.ex[i], op.set || {})
      changes.push({ op, position: i + 1, before, after: view(r.ex[i], S) })
    } else if (op.op === 'add' || op.op === 'replace') {
      const id = op.op === 'add' ? op.exercise_id : op.new_exercise_id
      if (!id || !known(id, S)) throw codeErr('EINVAL', `unknown exercise id ${id} — use one of the profile's custom exercises or the built-in catalogue`)
      const set = op.set || {}
      const mode = set.mode || 'reps'; checkFields(set, mode)
      if (set.sets == null) throw codeErr('EINVAL', `${op.op}: set.sets is required`)
      if (mode === 'reps' && set.reps == null) throw codeErr('EINVAL', `${op.op}: set.reps is required in reps mode`)
      if (mode === 'time' && set.sec == null) throw codeErr('EINVAL', `${op.op}: set.sec is required in time mode`)
      const e = { id, sets: set.sets, mode, prog: set.progression || 'off' }
      setFields(e, { ...set, progression: undefined })
      if (op.op === 'add') {
        const at = op.position != null ? op.position - 1 : r.ex.length
        if (!(Number.isInteger(at) && at >= 0 && at <= r.ex.length)) throw codeErr('EINVAL', `position ${op.position} is outside 1–${r.ex.length + 1}`)
        r.ex.splice(at, 0, e); changes.push({ op, position: at + 1, before: null, after: view(e, S) })
      } else {
        const i = indexOf(r, op, S); const before = view(r.ex[i], S)
        for (const k of ['sg', 'sgName', 'sgRest']) if (r.ex[i][k] != null) e[k] = r.ex[i][k]   // stays in its superset, as in the app
        r.ex[i] = e; changes.push({ op, position: i + 1, before, after: view(e, S) })
      }
    } else if (op.op === 'remove') {
      const i = indexOf(r, op, S); const before = view(r.ex[i], S)
      r.ex.splice(i, 1); changes.push({ op, position: i + 1, before, after: null })
    } else if (op.op === 'move') {
      const i = indexOf(r, op, S); const to = op.to_position
      if (!(Number.isInteger(to) && to >= 1 && to <= r.ex.length)) throw codeErr('EINVAL', `to_position ${to} is outside 1–${r.ex.length}`)
      const [e] = r.ex.splice(i, 1); r.ex.splice(to - 1, 0, e)
      changes.push({ op, from: i + 1, to, exercise: nameOf(e.id, S) })
    } else if (op.op === 'superset') {
      const sg = linkSuperset(r, op.positions, op)
      changes.push({ op, superset: sg, exercises: r.ex.filter(e => e.sg === sg).map(e => nameOf(e.id, S)) })
    } else if (op.op === 'unsuperset') {
      const i = indexOf(r, op, S); const g = r.ex[i].sg
      if (!g) throw codeErr('EINVAL', `${nameOf(r.ex[i].id, S)} is not in a superset`)
      const names = r.ex.filter(e => e.sg === g).map(e => nameOf(e.id, S))
      for (const e of r.ex) if (e.sg === g) dropSg(e)
      changes.push({ op, unlinked: names })
    } else throw codeErr('EINVAL', `unknown op ${op.op}`)
    cleanupSupersets(r.ex)
  }
  if (!r.ex.length) throw codeErr('EINVAL', 'a routine needs at least one exercise')
  return { routine: { id: r.id, name: r.name }, changes, exercises_after: r.ex.map((e, i) => ({ position: i + 1, ...view(e, S) })) }
}

/* Custom exercises (the profile's own, e.g. imported from Hevy): body part `bp`, primary muscle
   `tg` and secondary muscles `sm` — the fields lib/muscles.js reads before falling back to the
   body part. Workouts logged since the app began snapshotting muscles (`muscleSnapshot` on an
   entry) keep the snapshot taken at the time; `refresh_history` re-takes it for the edited
   exercises so past sessions are drawn with the corrected muscles too. */
export function editCustomExercises(S, { exercises = [], refresh_history = true }) {
  if (!exercises.length) throw codeErr('EINVAL', 'exercises: give at least one')
  const muscle = (m, k) => { if (!MUSCLES.includes(m)) throw codeErr('EINVAL', `${k}: unknown muscle "${m}" — one of ${MUSCLES.join(', ')}`); return m }
  const byId = new Map((S.customEx || []).map(c => [c.id, c]))
  const changes = [], edited = new Map()
  for (const x of exercises) {
    const c = byId.get(x.exercise_id)
    if (!c) throw codeErr('EINVAL', `${x.exercise_id} is not one of the profile's custom exercises (built-in catalogue exercises already carry their muscles)`)
    const before = { name: c.n, body_part: c.bp, primary: c.tg || null, secondary: Array.isArray(c.sm) ? c.sm : (c.sm ? [c.sm] : []) }
    if (x.name != null) { const n = String(x.name).trim(); if (!n) throw codeErr('EINVAL', 'name: empty'); c.n = n }
    if (x.body_part != null) { if (!BODYPARTS.includes(x.body_part)) throw codeErr('EINVAL', `body_part: one of ${BODYPARTS.join(', ')}`); c.bp = x.body_part }
    if (x.primary != null) c.tg = muscle(x.primary, 'primary')
    if (x.secondary != null) c.sm = [...new Set(x.secondary.map(m => muscle(m, 'secondary')))].filter(m => m !== c.tg)
    edited.set(c.id, c)
    changes.push({ exercise_id: c.id, before, after: { name: c.n, body_part: c.bp, primary: c.tg || null, secondary: c.sm || [] } })
  }
  let refreshed = 0
  if (refresh_history) {
    for (const w of S.workouts || []) for (const e of w.entries || []) {
      const c = edited.get(e.id)
      if (c && e.muscleSnapshot) { e.muscleSnapshot = exerciseMuscleSnapshot(c); refreshed++ }
    }
  }
  return { changes, history_entries_refreshed: refreshed }
}

/* A new routine, built with the same ops edit_routine takes (add, superset, …). It is not put on
   the weekly plan: assign_weekday does that, so a routine done at home or on demand stays off it. */
export function createRoutine(S, { name, emoji, ops = [] }) {
  const n = String(name || '').trim()
  if (!n) throw codeErr('EINVAL', 'name: required')
  if (!ops.some(o => o.op === 'add')) throw codeErr('EINVAL', 'ops: add at least one exercise')
  S.routines = Array.isArray(S.routines) ? S.routines : []
  if (S.routines.some(r => r.name.trim().toLowerCase() === n.toLowerCase())) throw codeErr('EINVAL', `a routine called "${n}" already exists — use edit_routine`)
  const id = 'mc' + crypto.randomBytes(6).toString('hex')
  S.routines.push({ id, name: n, emoji: emoji || 'figureStrength', prog: 'off', ex: [] })
  const out = editRoutine(S, { routine_id: id, ops })
  return { created: true, ...out, note: 'not on the weekly plan — open it from the routine list, or use assign_weekday' }
}

/* Bring back what a device kept but the server never got (a phone's "kept changes" export, a
   backup): workouts whose id the profile does not have, and weigh-ins / measurements for days it
   has none of. Nothing already on the server is touched, so running it twice adds nothing. */
const ISO = /^\d{4}-\d{2}-\d{2}$/
export function importData(S, { workouts = [], bodyweight = [], measurements = [] }) {
  S.workouts = Array.isArray(S.workouts) ? S.workouts : []
  const have = new Set(S.workouts.map(w => w.id))
  const added = [], skipped = []
  for (const w of workouts) {
    if (!w || typeof w.id !== 'string' || !ISO.test(w.d || '') || !Array.isArray(w.entries)) throw codeErr('EINVAL', `workout ${w?.id ?? '?'}: needs id, d (YYYY-MM-DD) and entries`)
    for (const e of w.entries) if (!e || typeof e.id !== 'string' || !Array.isArray(e.sets)) throw codeErr('EINVAL', `workout ${w.id}: every entry needs an exercise id and sets`)
    if (have.has(w.id)) { skipped.push({ id: w.id, date: w.d, why: 'already on the server' }); continue }
    S.workouts.push(structuredClone(w)); have.add(w.id)
    added.push({ id: w.id, date: w.d, name: w.name || null, exercises: w.entries.length, sets: w.entries.reduce((n, e) => n + e.sets.filter(x => x.done !== false).length, 0) })
  }
  S.workouts.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : (a.start || 0) - (b.start || 0)))
  const byDay = (list, items, label) => {
    const days = new Set(list.map(x => x.d)), out = []
    for (const x of items) {
      if (!x || !ISO.test(x.d || '')) throw codeErr('EINVAL', `${label}: every item needs d (YYYY-MM-DD)`)
      if (days.has(x.d)) continue
      list.push(structuredClone(x)); days.add(x.d); out.push(x.d)
    }
    list.sort((a, b) => (a.d < b.d ? -1 : 1))
    return out
  }
  S.bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : []
  S.measurements = Array.isArray(S.measurements) ? S.measurements : []
  for (const b of bodyweight) if (!(typeof b?.w === 'number' && b.w > 0)) throw codeErr('EINVAL', 'bodyweight: every item needs w')
  return {
    workouts_added: added, workouts_skipped: skipped,
    bodyweight_days_added: byDay(S.bodyweight, bodyweight, 'bodyweight'),
    measurement_days_added: byDay(S.measurements, measurements, 'measurements')
  }
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export function assignWeekday(S, { weekday, routine_ids }) {
  for (const id of routine_ids) if (!(S.routines || []).some(r => r.id === id)) throw codeErr('EINVAL', `no routine with id ${id}`)
  S.week = S.week && typeof S.week === 'object' ? S.week : {}
  const key = String(weekday), before = S.week[key] || []
  if (routine_ids.length) S.week[key] = [...routine_ids]; else delete S.week[key]
  const names = ids => ids.map(id => (S.routines.find(r => r.id === id) || {}).name || id)
  return { weekday, weekday_name: DAY[weekday], before: names(before), after: routine_ids.length ? names(routine_ids) : 'rest' }
}

export function addBodyweight(S, { weight, date, now = Date.now() }) {
  S.bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : []
  const before = S.bodyweight.find(b => b.d === date) || null
  S.bodyweight = S.bodyweight.filter(b => b.d !== date)
  S.bodyweight.push({ d: date, w: Math.round(weight * 10) / 10, t: now })
  S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
  return { date, unit: S.unit || 'kg', before: before ? before.w : null, after: Math.round(weight * 10) / 10 }
}

/* ---------- tool definitions ---------- */

const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(
  v => { const d = new Date(v + 'T12:00:00'); return !Number.isNaN(d.getTime()) && localIso(d) === v },
  { message: 'not a date the calendar has (YYYY-MM-DD)' })
const APPLY = z.boolean().optional().describe('false (default) only previews the change; true writes it to openGym. Show the preview to the user and get their OK before applying.')
const FIELDS = z.object({
  sets: z.number().int().optional(), reps: z.number().int().optional().describe('reps target (the top of the range for double progression)'),
  reps_min: z.number().int().nullable().optional().describe('bottom of the rep range (double progression)'),
  weight: z.number().nullable().optional().describe('target weight in the profile unit; null clears it'),
  rest_sec: z.number().int().nullable().optional().describe('this exercise\'s rest in seconds; null = global rest timer'),
  progression: z.string().optional().describe('off | linear | greyskull | double | triple (reps mode); off | time (time mode)'),
  increment: z.number().nullable().optional().describe('load step per progression, profile unit'),
  sec: z.number().int().optional().describe('seconds per set (time mode)'),
  mode: z.enum(['reps', 'time', 'cardio']).optional()
}).partial()

export const editRoutineTool = {
  name: 'edit_routine',
  description: 'Change a routine: update an exercise\'s sets/reps/weight/rest/progression, add, replace, remove or move exercises, link neighbouring exercises into a superset (op superset, with the rest between rounds) or unlink one (op unsuperset), or rename it. Writes go through the running openGym server (merged with other devices, never overwriting them). Previews by default — pass apply: true only after the user agreed. Address an exercise by exercise_id, or by 1-based position when it appears twice (e.g. squat in two places). Note: when the routine has never been logged, the app opens with the last weight from history rather than this target (imported history carries no plan).',
  schema: {
    routine_id: z.string().describe('from list_routines'),
    rename: z.string().optional(),
    ops: z.array(z.object({
      op: z.enum(['update', 'add', 'replace', 'remove', 'move', 'superset', 'unsuperset']),
      exercise_id: z.string().optional().describe('update/remove/move/replace: the exercise to address; add: the exercise to add'),
      position: z.number().int().optional().describe('1-based; for add, where to insert (default: last)'),
      new_exercise_id: z.string().optional().describe('replace: the exercise that takes its place'),
      to_position: z.number().int().optional().describe('move: 1-based target'),
      positions: z.array(z.number().int()).optional().describe('superset: the 1-based positions to link — 2 or more, next to each other (move them first if needed)'),
      rest_sec: z.number().int().optional().describe('superset: rest after each round, seconds'),
      name: z.string().optional().describe('superset: optional group name'),
      set: FIELDS.optional()
    })).optional(),
    apply: APPLY
  },
  handler: ({ apply, ...args }) => commit(S => editRoutine(S, args), { apply })
}

export const assignWeekdayTool = {
  name: 'assign_weekday',
  description: 'Set which routine(s) the weekly plan trains on a weekday (JS getDay: 0 = Sunday … 6 = Saturday). An empty routine_ids makes it a rest day. Previews by default; apply: true writes through the running server.',
  schema: { weekday: z.number().int().min(0).max(6), routine_ids: z.array(z.string()), apply: APPLY },
  handler: ({ apply, ...args }) => commit(S => assignWeekday(S, args), { apply })
}

export const addBodyweightTool = {
  name: 'add_bodyweight',
  description: 'Log a body-weight weigh-in (profile unit) for a date, replacing that day\'s entry if there is one. Previews by default; apply: true writes through the running server.',
  schema: { weight: z.number().min(20).max(400), date: isoDate().optional().describe('YYYY-MM-DD, default today'), apply: APPLY },
  handler: ({ apply, weight, date }) => commit(S => addBodyweight(S, { weight, date: date || localIso(new Date()) }), { apply })
}

export const editCustomExercisesTool = {
  name: 'edit_custom_exercises',
  description: 'Fix the body part and muscles of the profile\'s own custom exercises (e.g. imported from Hevy, which arrive with no muscles and a wrong body part, so the app draws a bench day as legs). Sets body_part, primary muscle and secondary muscles (and optionally the name) for one or many exercises in one write; with refresh_history (default true) it also re-takes the muscle snapshot of past sessions of those exercises. Previews by default; apply: true writes through the running server.',
  schema: {
    exercises: z.array(z.object({
      exercise_id: z.string(),
      name: z.string().optional(),
      body_part: z.string().optional().describe(`one of ${BODYPARTS.join(', ')}`),
      primary: z.string().optional().describe(`main muscle: one of ${MUSCLES.join(', ')}`),
      secondary: z.array(z.string()).optional().describe('supporting muscles, same names')
    })),
    refresh_history: z.boolean().optional(),
    apply: APPLY
  },
  handler: ({ apply, ...args }) => commit(S => editCustomExercises(S, args), { apply })
}

export const createRoutineTool = {
  name: 'create_routine',
  description: 'Create a new routine from a name and the same ops edit_routine takes (add exercises, then link neighbours with superset). It is NOT put on the weekly plan (use assign_weekday for that), so it suits sessions done at home or on demand. Previews by default; apply: true writes through the running server.',
  schema: {
    name: z.string(),
    emoji: z.string().optional().describe('an app icon name, e.g. figureStrength, legs, barbell, bolt'),
    ops: editRoutineTool.schema.ops,
    apply: APPLY
  },
  handler: ({ apply, ...args }) => commit(S => createRoutine(S, args), { apply })
}

export const importDataTool = {
  name: 'import_data',
  description: 'Bring back workouts, weigh-ins and body measurements a device kept but the server never received (e.g. from a phone\'s "kept changes" export or a backup file): adds workouts whose id the profile does not have yet and weigh-ins / measurements for days with none, in the app\'s own stored shape. Never changes or removes anything already there, so it is safe to repeat. Previews by default; apply: true writes through the running server.',
  schema: {
    workouts: z.array(z.object({ id: z.string(), d: z.string(), entries: z.array(z.object({ id: z.string(), sets: z.array(z.any()) }).passthrough()) }).passthrough()).optional(),
    bodyweight: z.array(z.object({ d: z.string(), w: z.number() }).passthrough()).optional(),
    measurements: z.array(z.object({ d: z.string() }).passthrough()).optional(),
    apply: APPLY
  },
  handler: ({ apply, ...args }) => commit(S => importData(S, args), { apply })
}

export const WRITE_TOOLS = /^(1|true|yes|on)$/i.test(process.env.OPENGYM_READONLY || '') ? [] : [editRoutineTool, createRoutineTool, assignWeekdayTool, addBodyweightTool, editCustomExercisesTool, importDataTool]
