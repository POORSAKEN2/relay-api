// "desert.site.garified.com" -> { slug: "desert" }. Anything else, including the booking app's
// "desert.garified.com" and deeper subdomains ("a.b.site.garified.com"), is not a site.
// When contractors can bring their own domain, this is where it gets recognised.
export function parseSiteHost(host: string, appDomain: string): { slug: string } | null {
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  const suffix = `.site.${appDomain}`
  if (!hostname.endsWith(suffix)) return null
  const slug = hostname.slice(0, -suffix.length)
  // Same slug rule as parseTenantHost in middleware/tenant.ts.
  return /^[a-z0-9-]+$/.test(slug) ? { slug } : null
}
