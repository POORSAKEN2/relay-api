import type { Response } from 'express'
import { Zip, ZipDeflate } from 'fflate'
import { logger } from '../../lib/logger.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { csvRow } from './csv.ts'
import * as queries from './export.queries.ts'

// The owner downloads all of the contractor's data as a ZIP with one CSV per table. Rows are
// read a batch at a time and written to the response as they are zipped, so a large contractor
// never sits in memory whole and the first bytes go out right away.

const encoder = new TextEncoder()

// Resolves when the socket is ready for more, or has closed (nothing left to wait for).
function drained(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

export async function streamExport(user: SessionUser, res: Response) {
  const tenantId = tenantOf(user)
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'export.downloaded',
    entityType: 'tenant',
    entityId: tenantId,
  })

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="relay-data-${new Date().toISOString().slice(0, 10)}.zip"`,
  )
  res.setHeader('Cache-Control', 'no-store')

  // A failed download must not look like a finished one, so an error cuts the connection.
  const fail = (error: unknown) => {
    logger.error({ err: error, tenantId }, 'Data export failed')
    res.destroy()
  }
  const zip = new Zip((error, chunk, final) => {
    if (error) return fail(error)
    res.write(chunk)
    if (final) res.end()
  })

  try {
    for (const spec of queries.EXPORT_TABLES) {
      const columns = queries.exportColumns(spec)
      const keys = Object.keys(columns)
      const file = new ZipDeflate(spec.file)
      zip.add(file)
      file.push(encoder.encode(csvRow(keys.map((key) => columns[key].name))), false)

      let afterId: string | null = null
      while (!res.destroyed) {
        const rows = await queries.listBatch(spec, tenantId, afterId)
        const csv = rows.map((row) => csvRow(keys.map((key) => row[key]))).join('')
        const last = rows.at(-1)
        const done = rows.length < queries.BATCH_SIZE
        file.push(encoder.encode(csv), done)
        if (res.writableNeedDrain) await drained(res)
        if (done) break
        afterId = last?.id as string
      }
      if (res.destroyed) return // the browser gave up; stop reading the database
    }
    zip.end()
  } catch (error) {
    fail(error)
  }
}
