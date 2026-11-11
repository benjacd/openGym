// get_measurements: tape check-ins come back in the profile's unit, only filled fields are listed,
// a same-day weigh-in is attached, and the change is first → last reading per field.
import { describe, test, expect, beforeAll } from 'vitest'
import { _seedStateForTests } from '../src/state.js'
import { TOOLS } from '../src/tools.js'

const call = (p = {}) => TOOLS.find(t => t.name === 'get_measurements').handler(p)

function state(unit = 'kg') {
  return {
    unit,
    bodyweight: [{ d: '2026-11-01', w: 83 }, { d: '2026-11-08', w: 82.7 }],
    customMeasurements: [{ id: 'c1', name: 'Neck relaxed' }],
    measurements: [
      { d: '2026-11-08', waist: 86, upperArmRight: 36.5, other: [{ id: 'c1', value: 40 }] },
      { d: '2026-11-01', waist: 87, upperArmRight: 36, chest: 104, bodyFat: 17 },
      { d: '2026-10-01', waist: 0, chest: 'x' }   // junk only → dropped
    ]
  }
}

describe('get_measurements', () => {
  beforeAll(() => _seedStateForTests(state()))

  test('chronological check-ins with only the filled fields and the same-day weigh-in', () => {
    _seedStateForTests(state())
    const r = call({ to: '2026-11-30' })
    expect(r.unit).toBe('cm')
    expect(r.count).toBe(2)
    expect(r.entries.map(e => e.date)).toEqual(['2026-11-01', '2026-11-08'])
    expect(r.entries[0]).toEqual({ date: '2026-11-01', weight_same_day: 83, values: { chest: 104, waist: 87, upperArmRight: 36, bodyFat: 17 } })
    expect(r.entries[1].values['other:c1']).toBe(40)
    expect(r.fields['other:c1']).toBe('Neck relaxed')
    expect(r.fields.waist).toBe('Waist')
  })

  test('latest per field and first-to-last change', () => {
    _seedStateForTests(state())
    const r = call({ to: '2026-11-30' })
    expect(r.latest.chest).toEqual({ date: '2026-11-01', value: 104 })
    expect(r.change.waist).toEqual({ from: 87, from_date: '2026-11-01', to: 86, to_date: '2026-11-08', delta: -1 })
    expect(r.change.upperArmRight.delta).toBe(0.5)
    expect(r.change.chest).toBeUndefined()   // one reading → no change
  })

  test('range filter and lb profiles in inches (body fat stays %)', () => {
    _seedStateForTests(state('lb'))
    const r = call({ from: '2026-11-02', to: '2026-11-30' })
    expect(r.unit).toBe('in')
    expect(r.count).toBe(1)
    expect(r.entries[0].values.waist).toBe(33.9)
    _seedStateForTests(state('lb'))
    expect(call({ from: '2026-11-01', to: '2026-11-01' }).entries[0].values.bodyFat).toBe(17)
  })

  test('no measurements → empty, not an error', () => {
    _seedStateForTests({ unit: 'kg', bodyweight: [] })
    const r = call()
    expect(r.count).toBe(0)
    expect(r.entries).toEqual([])
  })

  test('cached state is not mutated', () => {
    const s = state()
    _seedStateForTests(s)
    call({ to: '2026-11-30' })
    expect(s.measurements.length).toBe(3)
  })
})
