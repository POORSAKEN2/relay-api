import { db } from '../../db/client.ts'
import * as queries from './customers.queries.ts'
import type { CustomerListQuery, NewCustomerInput, NewProperty } from './customers.schemas.ts'

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

// The office adds a customer from the customers screen, with their address when known.
export async function create(tenantId: string, input: NewCustomerInput) {
  const { property, ...contact } = input
  return db.transaction(async (tx) => {
    const customer = await queries.insertCustomer(tenantId, { ...contact, source: 'office' }, tx)
    if (property) {
      await queries.insertProperty(
        tenantId,
        { ...propertyValues(property), customerId: customer.id },
        tx,
      )
    }
    return { id: customer.id }
  })
}

type AddressFields = NewProperty & {
  equipmentBrand?: string | null
  equipmentYear?: number | null
  notes?: string | null
}

// Every saved field of an address, blanks as null. The address dialog always sends the whole
// form, so anything it leaves out is cleared.
function propertyValues(input: AddressFields) {
  return {
    street: input.street,
    unit: input.unit || null,
    city: input.city,
    state: input.state,
    zip: input.zip,
    equipmentBrand: input.equipmentBrand ?? null,
    equipmentYear: input.equipmentYear ?? null,
    notes: input.notes ?? null,
  }
}
