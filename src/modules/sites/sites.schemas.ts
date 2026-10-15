import { z } from 'zod'
import { SITE_DESIGNS, SITE_PHOTO_KINDS } from '../../db/schema.ts'
import { UsState } from '../../lib/fields.ts'

// Limits match the database checks on `sites` (src/db/schema.ts).

// Optional text: trimmed, and a blank field is stored as null so an edit can clear it.
function optionalText(max: number, message: string) {
  return z.preprocess(
    (value) =>
      value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value,
    z.string().trim().max(max, message).nullable(),
  )
}

// Town names, each trimmed. Blanks are dropped and a name typed twice is kept once,
// whatever its case, before the limit of 30 applies.
const CitiesServed = z
  .array(z.string())
  .transform((cities) => {
    const seen = new Set<string>()
    const unique: string[] = []
    for (const city of cities.map((name) => name.trim())) {
      if (city === '' || seen.has(city.toLowerCase())) continue
      seen.add(city.toLowerCase())
      unique.push(city)
    }
    return unique
  })
  .pipe(
    z
      .array(z.string().max(60, 'Keep each city under 60 characters'))
      .max(30, 'List up to 30 cities'),
  )

export const SiteInput = z.object({
  design: z.enum(SITE_DESIGNS),
  headline: z
    .string()
    .trim()
    .min(1, 'Add a headline')
    .max(120, 'Keep the headline under 120 characters'),
  intro: z
    .string()
    .trim()
    .min(1, 'Add a short intro')
    .max(400, 'Keep the intro under 400 characters'),
  about: optionalText(2000, 'Keep this under 2,000 characters'),
  licenseNumber: optionalText(60, 'Keep the license number under 60 characters'),
  city: z.string().trim().min(1, 'Add your city').max(80, 'Keep the city under 80 characters'),
  region: UsState,
  citiesServed: CitiesServed,
  emergencyService: z.boolean(),
  showPrices: z.boolean(),
})
export type SiteInput = z.infer<typeof SiteInput>

export const PhotoParams = z.object({ photoId: z.uuid() })

// The upload's query string: ?kind=hero|work&alt=… The photo itself is the request body.
export const PhotoQuery = z.object({
  kind: z.enum(SITE_PHOTO_KINDS),
  alt: z
    .string()
    .trim()
    .min(1, 'Describe the photo for people who can’t see it')
    .max(200, 'Keep the description under 200 characters'),
})
export type PhotoQuery = z.infer<typeof PhotoQuery>

export const ReviewInput = z.object({
  authorName: z
    .string()
    .trim()
    .min(1, 'Add the reviewer’s name')
    .max(60, 'Keep the name under 60 characters'),
  place: optionalText(60, 'Keep the place under 60 characters'),
  rating: z.number().int().min(1, 'Pick 1 to 5 stars').max(5, 'Pick 1 to 5 stars'),
  body: z.string().trim().min(1, 'Add the review').max(600, 'Keep the review under 600 characters'),
})
export type ReviewInput = z.infer<typeof ReviewInput>

export const FaqInput = z.object({
  question: z
    .string()
    .trim()
    .min(1, 'Add the question')
    .max(200, 'Keep the question under 200 characters'),
  answer: z
    .string()
    .trim()
    .min(1, 'Add the answer')
    .max(1000, 'Keep the answer under 1,000 characters'),
})
export type FaqInput = z.infer<typeof FaqInput>

// Every id of the list, in the new order.
export const OrderInput = z.object({ ids: z.array(z.uuid()).max(200) })

export const ReviewParams = z.object({ reviewId: z.uuid() })
export const FaqParams = z.object({ faqId: z.uuid() })
