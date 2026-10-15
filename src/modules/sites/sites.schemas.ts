import { z } from 'zod'

export const PhotoParams = z.object({ photoId: z.uuid() })
