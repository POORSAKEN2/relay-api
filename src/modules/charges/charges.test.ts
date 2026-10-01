import { describe, expect, it } from 'vitest'
import { serviceLineDescription, summarize } from './charges.service.ts'

describe('serviceLineDescription', () => {
  it('names the booked service line by how the service is priced', () => {
    expect(serviceLineDescription('Tune-up', 'fixed')).toBe('Tune-up')
    expect(serviceLineDescription('AC repair', 'diagnostic')).toBe('AC repair (diagnostic fee)')
    expect(serviceLineDescription('New-system estimate', 'free')).toBe('New-system estimate (free)')
  })
})

describe('summarize', () => {
  it('adds up approved and waiting lines, and only waiting repairs can come off', () => {
    const line = (id: string, description: string, quantity: number, unitPriceCents: number) => ({
      id,
      description,
      quantity,
      unitPriceCents,
    })
    const rows = [
      { ...line('a', 'AC repair (diagnostic fee)', 1, 8900), status: 'approved' as const },
      { ...line('b', 'Capacitor replacement', 2, 18500), status: 'proposed' as const },
      { ...line('c', 'Contactor replacement', 1, 16500), status: 'declined' as const },
    ]

    expect(summarize(rows)).toEqual({
      lines: [
        { ...rows[0], totalCents: 8900, removable: false },
        { ...rows[1], totalCents: 37000, removable: true },
        { ...rows[2], totalCents: 16500, removable: false },
      ],
      approvedTotalCents: 8900,
      proposedTotalCents: 37000,
    })
  })
})
