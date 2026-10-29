import { describe, expect, it } from 'vitest'
import {
  type BudgetRow,
  calculate,
  calculateAllocated,
  calculateHierarchyTotal,
  calculateReportsTotal,
  calculateReserveRowAmount,
  calculateTotal,
  flattenBudget,
  nonlinearRate,
  parseBudgetData,
  reserveFeeAmount
} from '../src/firebase/campaigns/budgetMath.js'

type FeeConfig = { baseMin: number; rateAtMin: number; baseMax: number; rateAtMax: number; offset?: number }

let uidCounter = 0
function leaf(price: number, content: Record<string, unknown> = {}): BudgetRow {
  uidCounter += 1
  return { uid: `leaf-${uidCounter}`, name: `leaf-${uidCounter}`, content: { price, selectedQuantity: 1, ...content } }
}

function group(subRows: BudgetRow[], content: Record<string, unknown> = {}): BudgetRow {
  uidCounter += 1
  return {
    uid: `group-${uidCounter}`,
    name: `group-${uidCounter}`,
    content: { price: 0, selectedQuantity: 1, ...content },
    subRows
  }
}

function linearFee(percent: number, offset = 0): BudgetRow {
  uidCounter += 1
  return {
    uid: `fee-${uidCounter}`,
    name: `fee-${uidCounter}`,
    content: { price: 0, effort: 'reserve', feeMode: 'linear', selectedQuantity: percent, offset }
  }
}

function nonlinearFee({ baseMin, rateAtMin, baseMax, rateAtMax, offset = 0 }: FeeConfig): BudgetRow {
  uidCounter += 1
  return {
    uid: `fee-${uidCounter}`,
    name: `fee-${uidCounter}`,
    content: {
      price: 0,
      selectedQuantity: 0,
      effort: 'reserve',
      feeMode: 'nonlinear',
      baseMin,
      rateAtMin,
      baseMax,
      rateAtMax,
      offset
    }
  }
}

const AM_SERVICE: FeeConfig = { baseMin: 1000, rateAtMin: 2.8, baseMax: 150000, rateAtMax: 2.0, offset: 150 }
const CREW_COSTS: FeeConfig = { baseMin: 500, rateAtMin: 25, baseMax: 50000, rateAtMax: 10, offset: 0 }
const PRE_PRODUCTION: FeeConfig = { baseMin: 500, rateAtMin: 5, baseMax: 100000, rateAtMax: 4, offset: 100 }

describe('golden cases from colada-campaigns-backoffice src/Campaigns/utils.test.ts', () => {
  describe('calculate (leaf totals)', () => {
    it('multiplies price by quantity', () => {
      expect(calculate(leaf(100, { selectedQuantity: 3 }))).toBe(300)
    })

    it('applies qty2, discount and vat', () => {
      expect(calculate(leaf(100, { selectedQuantity: 2, qty2: 3, disc: 10, vat: 20 }))).toBeCloseTo(648, 6)
    })

    it('treats reserve rows as zero in the leaf path', () => {
      expect(calculate(linearFee(10, 50))).toBe(0)
    })
  })

  describe('nonlinearRate', () => {
    it('interpolates linearly between the configured points', () => {
      expect(nonlinearRate(500, CREW_COSTS)).toBeCloseTo(25, 6)
      expect(nonlinearRate(50000, CREW_COSTS)).toBeCloseTo(10, 6)
      expect(nonlinearRate(1540, CREW_COSTS)).toBeCloseTo(24.684848, 5)
    })

    it('clamps below baseMin to rateAtMin', () => {
      expect(nonlinearRate(0, CREW_COSTS)).toBe(25)
    })

    it('clamps above baseMax to rateAtMax (never negative)', () => {
      expect(nonlinearRate(100000, CREW_COSTS)).toBe(10)
    })

    it('can run unclamped', () => {
      expect(nonlinearRate(100000, CREW_COSTS, false)).toBeLessThan(0)
    })

    it('returns rateAtMin when baseMin equals baseMax', () => {
      expect(nonlinearRate(1234, { baseMin: 500, rateAtMin: 7, baseMax: 500, rateAtMax: 3 })).toBe(7)
    })
  })

  describe('reserveFeeAmount', () => {
    it('computes linear fee = base * percent / 100 + offset', () => {
      expect(reserveFeeAmount(linearFee(10, 50), 1500)).toBeCloseTo(200, 6)
    })

    it('computes the linear credit-card fee fixture', () => {
      expect(reserveFeeAmount(linearFee(3.5), 1104.31)).toBeCloseTo(38.65, 2)
    })

    it('computes the linear short-notice fee fixture', () => {
      expect(reserveFeeAmount(linearFee(25), 883.45)).toBeCloseTo(220.86, 2)
    })
  })

  describe('calculateReserveRowAmount (non-linear fee fixtures)', () => {
    it('AM service fee: base = material + personnel', () => {
      const fee = nonlinearFee(AM_SERVICE)
      expect(calculateReserveRowAmount(fee, [leaf(2500), leaf(1540), fee])).toBeCloseTo(262.46, 2)
    })

    it('associated crew costs: base = personnel', () => {
      const fee = nonlinearFee(CREW_COSTS)
      expect(calculateReserveRowAmount(fee, [leaf(1540), fee])).toBeCloseTo(380.15, 2)
    })

    it('pre-production services: base = material', () => {
      const fee = nonlinearFee(PRE_PRODUCTION)
      expect(calculateReserveRowAmount(fee, [leaf(2500), fee])).toBeCloseTo(224.5, 2)
    })

    it('returns 0 for non-reserve rows', () => {
      expect(calculateReserveRowAmount(leaf(100), [leaf(100)])).toBe(0)
    })
  })

  describe('calculateTotal / calculateHierarchyTotal', () => {
    it('sums a flat group of leaves', () => {
      expect(calculateTotal([group([leaf(1000), leaf(500)])])).toBe(1500)
    })

    it('applies a linear reserve additively within a group', () => {
      expect(calculateTotal([group([leaf(1000), leaf(500), linearFee(10, 50)])])).toBeCloseTo(1700, 6)
    })

    it('sums multiple linear reserves like the old multiplicative model', () => {
      expect(calculateTotal([group([leaf(1000), leaf(500), linearFee(5), linearFee(5)])])).toBeCloseTo(1650, 6)
    })

    it('applies a non-linear reserve within a group', () => {
      const fee = nonlinearFee(CREW_COSTS)
      expect(calculateTotal([group([leaf(1540), fee])])).toBeCloseTo(1540 + 380.146, 2)
    })

    it('rolls nested group reserves into the parent total', () => {
      const inner = group([leaf(1000), linearFee(10)])
      expect(calculateHierarchyTotal(group([inner, leaf(500)]))).toBeCloseTo(1600, 6)
    })
  })
})

describe('rules of the original kept on purpose (AC-F21: same as the UI)', () => {
  it('options and recurring rows count only in the total with options', () => {
    const tree = [
      leaf(100),
      leaf(50, { effort: 'option' }),
      leaf(30, { effort: 'recurring' }),
      leaf(20, { effort: 'nip' })
    ]
    expect(calculateTotal(tree)).toBe(100)
    expect(calculateTotal(tree, true)).toBe(180)
  })

  it('a root-level reserve applies to the whole budget', () => {
    expect(calculateTotal([leaf(1000), group([leaf(500)]), linearFee(10)])).toBeCloseTo(1650, 6)
  })

  it('converts row currencies with the project exchange rates; no rates means no conversion', () => {
    const tree = [leaf(100, { currency: 'EUR' }), leaf(100, { currency: 'CHF' })]
    expect(calculateTotal(tree, false, 'CHF', { EUR: 0.9 })).toBeCloseTo(190, 6)
    expect(calculateTotal(tree, false, 'CHF', null)).toBe(200)
    expect(calculateTotal(tree, false, 'CHF', { USD: 2 })).toBe(200)
  })

  it('selectedQuantity 0 makes the row 0; a missing quantity keeps the price', () => {
    expect(calculate(leaf(100, { selectedQuantity: 0 }))).toBe(0)
    expect(calculate({ uid: 'x', content: { price: 100 } })).toBe(100)
  })

  it('a non-numeric price makes NaN, as in the UI (Number("abc"))', () => {
    expect(calculate(leaf(0, { price: 'abc' }))).toBeNaN()
  })

  it('calculateAllocated does not convert numbers: a string allocated is concatenated, as in the UI', () => {
    expect(calculateAllocated([leaf(1, { allocated: 5 }), leaf(1, { allocated: 7 })])).toBe(12)
    expect(calculateAllocated([leaf(1, { allocated: 5 }), leaf(1, { allocated: '7' })])).toBe('57')
  })

  it('actual = booked minutes / 60 x price + invoices with rates; no reserve in actual', () => {
    const row = leaf(120, {
      reports: { '2026-09-01': [{ hours: 1, minutes: 30 }], '2026-09-02': [{ hours: '0', minutes: '30' }] },
      invoices: [{ amount: 100, currency: 'EUR' }, { amount: '50' }]
    })
    expect(calculateReportsTotal([group([row, linearFee(10)])], { EUR: 0.9 })).toBeCloseTo(240 + 90 + 50, 6)
  })
})

describe('parseBudgetData (Budget/utils.js)', () => {
  it.each([
    [null, []],
    [undefined, []],
    ['x', []],
    [{}, []],
    [{ list: [{ uid: 'a' }] }, [{ uid: 'a' }]],
    [{ 1: { uid: 'b' }, 0: { uid: 'a' }, 10: { uid: 'c' } }, [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }]],
    [{ uid: 'a', content: { price: 1 } }, [{ uid: 'a', content: { price: 1 } }]],
    [{ x: { uid: 'a' }, y: { uid: 'b' } }, [{ uid: 'a' }, { uid: 'b' }]]
  ])('%j → %j', (input, output) => {
    expect(parseBudgetData(input)).toEqual(output)
  })

  it('keeps holes of an array, as the UI does', () => {
    expect(parseBudgetData([{ uid: 'a' }, null])).toEqual([{ uid: 'a' }, null])
  })
})

describe('flattenBudget', () => {
  it('lists every row with depth, path, row total, reserve amount, booked hours and actual', () => {
    const fee = {
      uid: 'f',
      name: 'Fee',
      content: { price: 0, effort: 'reserve', feeMode: 'linear', selectedQuantity: 10 }
    }
    const tree: BudgetRow[] = [
      {
        uid: 'g',
        name: 'Hall',
        content: { price: 0 },
        subRows: [
          {
            uid: 'r1',
            name: 'Room',
            content: { price: 100, selectedQuantity: 2, reports: { d: [{ hours: 1, minutes: 0 }] } }
          },
          fee
        ]
      }
    ]
    expect(flattenBudget(tree)).toEqual([
      expect.objectContaining({
        uid: 'g',
        depth: 0,
        path: 'Hall',
        isGroup: true,
        total: 220,
        reportedHours: 0,
        actual: 100
      }),
      expect.objectContaining({
        uid: 'r1',
        depth: 1,
        path: 'Hall > Room',
        total: 200,
        reportedHours: 1,
        actual: 100,
        quantity: 2
      }),
      expect.objectContaining({
        uid: 'f',
        depth: 1,
        path: 'Hall > Fee',
        total: 0,
        reserveAmount: 20,
        effort: 'reserve'
      })
    ])
    expect(Object.keys(flattenBudget(tree)[1] ?? {})).not.toContain('reports')
  })
})
