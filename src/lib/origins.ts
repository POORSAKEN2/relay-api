import { env } from '../config/env.ts'

// Browser origins allowed to call the API with cookies: subdomains of APP_DOMAIN.
export function isAllowedOrigin(origin: string, appDomain: string, production: boolean): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const secure = url.protocol === 'https:' || (!production && url.protocol === 'http:')
  return secure && url.hostname.endsWith(`.${appDomain}`)
}

// The `origin` option for cors() and Socket.IO.
export function checkOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
) {
  const production = env.NODE_ENV === 'production'
  callback(null, !!origin && isAllowedOrigin(origin, env.APP_DOMAIN, production))
}
