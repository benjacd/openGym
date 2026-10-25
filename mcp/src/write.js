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
import { exOr, EXIDX } from '../../frontend/src/lib/exercises.js'
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

const view = (e, S) => e && ({ exercise: nameOf(e.id, S), id: e.id, sets: e.sets, mode: modeOfEntry(e), reps: e.reps, reps_min: e.repsMin, sec: e.sec, weight: e.weight, rest_sec: e.restSec, progression: e.prog, increment: e.inc })

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
    } else throw codeErr('EINVAL', `unknown op ${op.op}`)
  }
  if (!r.ex.length) throw codeErr('EINVAL', 'a routine needs at least one exercise')
  return { routine: { id: r.id, name: r.name }, changes, exercises_after: r.ex.map((e, i) => ({ position: i + 1, ...view(e, S) })) }
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
  description: 'Change a routine: update an exercise\'s sets/reps/weight/rest/progression, add, replace, remove or move exercises, or rename it. Writes go through the running openGym server (merged with other devices, never overwriting them). Previews by default — pass apply: true only after the user agreed. Address an exercise by exercise_id, or by 1-based position when it appears twice (e.g. squat in two places). Note: when the routine has never been logged, the app opens with the last weight from history rather than this target (imported history carries no plan).',
  schema: {
    routine_id: z.string().describe('from list_routines'),
    rename: z.string().optional(),
    ops: z.array(z.object({
      op: z.enum(['update', 'add', 'replace', 'remove', 'move']),
      exercise_id: z.string().optional().describe('update/remove/move/replace: the exercise to address; add: the exercise to add'),
      position: z.number().int().optional().describe('1-based; for add, where to insert (default: last)'),
      new_exercise_id: z.string().optional().describe('replace: the exercise that takes its place'),
      to_position: z.number().int().optional().describe('move: 1-based target'),
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

export const WRITE_TOOLS = /^(1|true|yes|on)$/i.test(process.env.OPENGYM_READONLY || '') ? [] : [editRoutineTool, assignWeekdayTool, addBodyweightTool]
