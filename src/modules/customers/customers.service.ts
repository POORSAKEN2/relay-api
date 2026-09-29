import * as queries from './customers.queries.ts'

const MIN_QUERY_LENGTH = 2
const MAX_RESULTS = 10

// Search as the office types: by name, or by 3+ digits of the phone number.
export async function search(tenantId: string, q: string) {
  if (q.length < MIN_QUERY_LENGTH) return []
  const digits = q.replace(/\D/g, '')
  const found = await queries.searchCustomers(
    tenantId,
    { name: q, phoneDigits: digits.length >= 3 ? digits : null },
    MAX_RESULTS,
  )
  const properties = await queries.listProperties(
    tenantId,
    found.map((customer) => customer.id),
  )
  return found.map((customer) => ({
    ...customer,
    properties: properties
      .filter((property) => property.customerId === customer.id)
      .map(({ customerId: _, ...property }) => property),
  }))
}
