// Phase 2 write tools: the pure changes, the session token, and the read-change-write loop
// against a fake server (200, 409 then 200, refusal).
import { describe, test, expect, vi, beforeAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let W
const SECRET = 'test-secret'
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-write-'))
  fs.writeFileSync(path.join(dir, 'secret'), SECRET)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'u1', name: 'T', sv: 2 }] }))
  fs.writeFileSync(path.join(dir, 'state-u1.json'), '{}')
  process.env.OPENGYM_DATA = dir
  process.env.OPENGYM_URL = 'http://og.test/'
  W = await import('../src/write.js')
})

const state = () => ({
  unit: 'kg', week: { 1: ['r1'] }, bodyweight: [{ d: '2026-10-20', w: 83, t: 1 }],
  customEx: [{ id: 'cx', n: 'mi press' }],
  routines: [{ id: 'r1', name: 'Pierna', ex: [
    { id: '3650', sets: 3, mode: 'reps', reps: 5, prog: 'off' },
    { id: 'cx', sets: 4, mode: 'reps', reps: 5, prog: 'linear', inc: 2.5 },
    { id: 'cx', sets: 3, mode: 'reps', reps: 8, prog: 'off' }
  ] }, { id: 'r2', name: 'Torso', ex: [{ id: 'cx', sets: 3, mode: 'reps', reps: 8 }] }]
})

describe('mintToken', () => {
  test('signs <uid>:<exp>:<sv>:c the way api/server.js verifies it', () => {
    const tok = W.mintToken({ uid: 'u1', secret: SECRET, sv: 2, now: 1000, ttl: 500 })
    const i = tok.lastIndexOf('.')
    expect(tok.slice(0, i)).toBe('u1:1500:2:c')
    expect(tok.slice(i + 1)).toBe(crypto.createHmac('sha256', SECRET).update('u1:1500:2:c').digest('base64url'))
  })
})

describe('editRoutine', () => {
  test('updates by position, sets rest and clears with null', () => {
    const S = state()
    const out = W.editRoutine(S, { routine_id: 'r1', ops: [{ op: 'update', position: 2, set: { weight: 115, rest_sec: 180 } }] })
    expect(S.routines[0].ex[1]).toMatchObject({ weight: 115, restSec: 180, prog: 'linear' })
    expect(out.changes[0].before.weight).toBeUndefined()
    W.editRoutine(S, { routine_id: 'r1', ops: [{ op: 'update', position: 2, set: { rest_sec: null } }] })
    expect(S.routines[0].ex[1].restSec).toBeUndefined()
  })
  test('an id that appears twice needs a position', () => {
    expect(() => W.editRoutine(state(), { routine_id: 'r1', ops: [{ op: 'update', exercise_id: 'cx', set: { sets: 2 } }] })).toThrow(/appears 2 times/)
  })
  test('add, replace, move, remove', () => {
    const S = state()
    W.editRoutine(S, { routine_id: 'r1', ops: [
      { op: 'replace', exercise_id: '3650', new_exercise_id: '2138', set: { sets: 6, mode: 'time', sec: 10, rest_sec: 90 } },
      { op: 'add', exercise_id: 'cx', position: 1, set: { sets: 3, reps: 10, reps_min: 8, progression: 'double' } },
      { op: 'move', position: 1, to_position: 4 },
      { op: 'remove', position: 3 }
    ] })
    expect(S.routines[0].ex.map(e => e.id)).toEqual(['2138', 'cx', 'cx'])
    expect(S.routines[0].ex[0]).toMatchObject({ mode: 'time', sec: 10, restSec: 90, prog: 'off' })
    expect(S.routines[0].ex[2]).toMatchObject({ reps: 10, repsMin: 8, prog: 'double' })
  })
  test('refuses bad input', () => {
    const f = ops => () => W.editRoutine(state(), { routine_id: 'r1', ops })
    expect(f([{ op: 'add', exercise_id: 'nope', set: { sets: 3, reps: 5 } }])).toThrow(/unknown exercise/)
    expect(f([{ op: 'update', position: 1, set: { progression: 'double', mode: 'time' } }])).toThrow(/progression/)
    expect(f([{ op: 'update', position: 2, set: { reps_min: 9 } }])).toThrow(/above reps/)
    expect(f([{ op: 'update', position: 9, set: { sets: 1 } }])).toThrow(/outside/)
    expect(() => W.editRoutine(state(), { routine_id: 'zz' })).toThrow(/no routine/)
  })
})

describe('supersets', () => {
  test('links neighbours in the app\'s shape, with the round rest on every member', () => {
    const S = state()
    const out = W.editRoutine(S, { routine_id: 'r1', ops: [{ op: 'superset', positions: [2, 3], rest_sec: 90, name: 'brazos' }] })
    const [, a, b] = S.routines[0].ex
    expect(a.sg).toMatch(/^sg[0-9a-f]+$/)
    expect(b.sg).toBe(a.sg)
    expect(a).toMatchObject({ sgRest: 90, sgName: 'brazos' })
    expect(b).toMatchObject({ sgRest: 90, sgName: 'brazos' })
    expect(S.routines[0].ex[0].sg).toBeUndefined()
    expect(out.exercises_after[1].superset).toBe(a.sg)
  })
  test('refuses exercises that are not next to each other, or fewer than two', () => {
    expect(() => W.editRoutine(state(), { routine_id: 'r1', ops: [{ op: 'superset', positions: [1, 3] }] })).toThrow(/next to each other/)
    expect(() => W.editRoutine(state(), { routine_id: 'r1', ops: [{ op: 'superset', positions: [2] }] })).toThrow(/at least two/)
  })
  test('unsuperset, and a member removed or moved away leaves no one-exercise group', () => {
    let S = state()
    W.editRoutine(S, { routine_id: 'r1', ops: [{ op: 'superset', positions: [1, 2] }, { op: 'remove', position: 2 }] })
    expect(S.routines[0].ex.some(e => e.sg)).toBe(false)
    S = state()
    W.editRoutine(S, { routine_id: 'r1', ops: [{ op: 'superset', positions: [1, 2], rest_sec: 60 }, { op: 'move', position: 1, to_position: 3 }] })
    expect(S.routines[0].ex.some(e => e.sg || e.sgRest)).toBe(false)
    S = state()
    W.editRoutine(S, { routine_id: 'r1', ops: [{ op: 'superset', positions: [2, 3] }, { op: 'unsuperset', position: 2 }] })
    expect(S.routines[0].ex.some(e => e.sg)).toBe(false)
    expect(() => W.editRoutine(state(), { routine_id: 'r1', ops: [{ op: 'unsuperset', position: 1 }] })).toThrow(/not in a superset/)
  })
  test('replace keeps the exercise in its superset', () => {
    const S = state()
    W.editRoutine(S, { routine_id: 'r1', ops: [{ op: 'superset', positions: [2, 3], rest_sec: 75 }, { op: 'replace', position: 3, new_exercise_id: '3650', set: { sets: 3, reps: 5 } }] })
    expect(S.routines[0].ex[2]).toMatchObject({ id: '3650', sgRest: 75 })
    expect(S.routines[0].ex[2].sg).toBe(S.routines[0].ex[1].sg)
  })
})

describe('editCustomExercises', () => {
  test('sets body part and muscles, and re-takes the snapshot of logged sessions', () => {
    const S = state()
    S.workouts = [{ d: '2026-10-27', entries: [{ id: 'cx', sets: [], muscleSnapshot: { n: 'mi press', bp: 'upper legs', muscleWeights: { quadriceps: 0.4 } } }, { id: 'zz', sets: [], muscleSnapshot: { bp: 'chest' } }] }]
    const out = W.editCustomExercises(S, { exercises: [{ exercise_id: 'cx', body_part: 'chest', primary: 'chest', secondary: ['triceps', 'deltoids', 'chest'] }] })
    expect(S.customEx[0]).toMatchObject({ bp: 'chest', tg: 'chest', sm: ['triceps', 'deltoids'] })
    expect(out.history_entries_refreshed).toBe(1)
    expect(S.workouts[0].entries[0].muscleSnapshot.muscleWeights.chest).toBe(1)
    expect(S.workouts[0].entries[0].muscleSnapshot.muscleWeights.quadriceps).toBeUndefined()
    expect(S.workouts[0].entries[1].muscleSnapshot).toEqual({ bp: 'chest' })
  })
  test('refuses unknown muscles, body parts and catalogue exercises', () => {
    expect(() => W.editCustomExercises(state(), { exercises: [{ exercise_id: 'cx', primary: 'pecs' }] })).toThrow(/unknown muscle/)
    expect(() => W.editCustomExercises(state(), { exercises: [{ exercise_id: 'cx', body_part: 'legs' }] })).toThrow(/body_part/)
    expect(() => W.editCustomExercises(state(), { exercises: [{ exercise_id: '3650', primary: 'chest' }] })).toThrow(/not one of the profile/)
  })
})

describe('createRoutine', () => {
  test('builds a routine off the weekly plan, supersets included', () => {
    const S = state()
    const out = W.createRoutine(S, { name: 'Core en casa', ops: [
      { op: 'add', exercise_id: '0857', set: { sets: 3, reps: 10 } },
      { op: 'add', exercise_id: '0715', set: { sets: 3, mode: 'time', sec: 30 } },
      { op: 'superset', positions: [1, 2], rest_sec: 60 }
    ] })
    const r = S.routines.at(-1)
    expect(r).toMatchObject({ name: 'Core en casa', prog: 'off' })
    expect(r.id).toMatch(/^mc[0-9a-f]+$/)
    expect(r.ex.map(e => e.id)).toEqual(['0857', '0715'])
    expect(r.ex[1].sg).toBe(r.ex[0].sg)
    expect(Object.values(S.week).flat().includes(r.id)).toBe(false)
    expect(out.created).toBe(true)
  })
  test('needs a name, an exercise, and a name not taken', () => {
    expect(() => W.createRoutine(state(), { name: ' ', ops: [{ op: 'add', exercise_id: '0857', set: { sets: 1, reps: 1 } }] })).toThrow(/name/)
    expect(() => W.createRoutine(state(), { name: 'X', ops: [] })).toThrow(/at least one exercise/)
    expect(() => W.createRoutine(state(), { name: 'pierna', ops: [{ op: 'add', exercise_id: '0857', set: { sets: 1, reps: 1 } }] })).toThrow(/already exists/)
  })
})

describe('importData', () => {
  test('adds only what is missing, and repeating it adds nothing', () => {
    const S = state()
    S.workouts = [{ id: 'w1', d: '2026-10-27', entries: [] }]
    const kept = {
      workouts: [{ id: 'w1', d: '2026-10-27', entries: [] }, { id: 'w3', d: '2026-10-30', start: 2, entries: [{ id: 'cx', sets: [{ w: 30, r: 10, done: true }] }] }, { id: 'w2', d: '2026-10-29', entries: [{ id: 'cx', sets: [{ w: 40, r: 3, done: true }, { w: 40, r: 3, done: false }] }] }],
      bodyweight: [{ d: '2026-10-20', w: 90, t: 1 }, { d: '2026-10-28', w: 83, t: 2 }],
      measurements: [{ d: '2026-10-28', waist: 87 }]
    }
    const out = W.importData(S, kept)
    expect(S.workouts.map(w => w.id)).toEqual(['w1', 'w2', 'w3'])
    expect(out.workouts_added.map(w => w.sets)).toEqual([1, 1])
    expect(out.workouts_skipped[0].id).toBe('w1')
    expect(S.bodyweight.find(b => b.d === '2026-10-20').w).toBe(83)
    expect(out.bodyweight_days_added).toEqual(['2026-10-28'])
    expect(S.measurements).toEqual([{ d: '2026-10-28', waist: 87 }])
    const again = W.importData(S, kept)
    expect(again.workouts_added.length).toBe(0)
    expect(again.bodyweight_days_added.length + again.measurement_days_added.length).toBe(0)
  })
  test('refuses malformed workouts', () => {
    expect(() => W.importData(state(), { workouts: [{ id: 'x', d: 'ayer', entries: [] }] })).toThrow(/needs id, d/)
    expect(() => W.importData(state(), { workouts: [{ id: 'x', d: '2026-10-29', entries: [{ sets: [] }] }] })).toThrow(/exercise id/)
  })
})

describe('assignWeekday / addBodyweight', () => {
  test('weekday set and cleared', () => {
    const S = state()
    expect(W.assignWeekday(S, { weekday: 4, routine_ids: ['r2'] }).after).toEqual(['Torso'])
    expect(S.week[4]).toEqual(['r2'])
    W.assignWeekday(S, { weekday: 1, routine_ids: [] })
    expect(S.week[1]).toBeUndefined()
    expect(() => W.assignWeekday(S, { weekday: 2, routine_ids: ['x'] })).toThrow(/no routine/)
  })
  test('weigh-in replaces the same day', () => {
    const S = state()
    W.addBodyweight(S, { weight: 82.04, date: '2026-10-20', now: 5 })
    W.addBodyweight(S, { weight: 81.5, date: '2026-10-25', now: 6 })
    expect(S.bodyweight).toEqual([{ d: '2026-10-20', w: 82, t: 5 }, { d: '2026-10-25', w: 81.5, t: 6 }])
  })
})

describe('commit', () => {
  const reply = (status, data) => Promise.resolve({ status, json: () => Promise.resolve(data) })
  const change = S => { S.week[3] = ['r1']; return { ok: 1 } }

  test('preview never PUTs', async () => {
    const fetchImpl = vi.fn(() => reply(200, { state: state(), rev: 4 }))
    const out = await W.commit(change, { fetchImpl })
    expect(out).toMatchObject({ applied: false, ok: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  test('PUTs with baseRev and a bearer, and re-applies after a 409', async () => {
    const fresh = state(); fresh.week[6] = ['r2']
    const calls = []
    const fetchImpl = vi.fn((url, init) => {
      calls.push([url, init])
      if (init.method === 'GET') return reply(200, { state: state(), rev: 4 })
      if (calls.length === 2) return reply(409, { error: 'conflict', state: fresh, rev: 5 })
      return reply(200, { ok: true, rev: 6 })
    })
    const out = await W.commit(change, { apply: true, fetchImpl })
    expect(out).toMatchObject({ applied: true, rev: 6 })
    expect(calls[0][0]).toBe('http://og.test/api/data')
    expect(calls[0][1].headers.authorization).toMatch(/^Bearer u1:\d+:2:c\./)
    const last = JSON.parse(calls[2][1].body)
    expect(last.baseRev).toBe(5)
    expect(last.state.week).toMatchObject({ 3: ['r1'], 6: ['r2'] })   // the other device's day survives
  })
  test('a refused write is an error, not a success', async () => {
    const fetchImpl = vi.fn((u, init) => init.method === 'GET' ? reply(200, { state: state(), rev: 1 }) : reply(400, { error: 'invalid state' }))
    await expect(W.commit(change, { apply: true, fetchImpl })).rejects.toThrow(/400: invalid state/)
  })
  test('no server is a clear error', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })))
    await expect(W.commit(change, { fetchImpl })).rejects.toThrow(/not reachable.*ECONNREFUSED/)
  })
})
