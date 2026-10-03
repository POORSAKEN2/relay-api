import * as queries from './customers.queries.ts'
import type { CustomerListQuery } from './customers.schemas.ts'

// Customers on one page of the list. The web app reads it from the response.
export const PAGE_SIZE = 25

// One page of the customer list, with every customer's addresses and visit dates.
export async function list(tenantId: string, query: CustomerListQuery) {
  const { rows, total } = await queries.listCustomers(tenantId, query, PAGE_SIZE)
  const properties = await queries.listProperties(
    tenantId,
    rows.map((customer) => customer.id),
  )
  return {
    customers: rows.map((customer) => ({
      ...customer,
      properties: addressesOf(customer.id, properties),
    })),
    total,
    pageSize: PAGE_SIZE,
  }
}

// One customer's addresses out of several customers' addresses, without the customer id.
function addressesOf(
  customerId: string,
  properties: Awaited<ReturnType<typeof queries.listProperties>>,
) {
  return properties
    .filter((property) => property.customerId === customerId)
    .map(({ customerId: _, ...property }) => property)
}
