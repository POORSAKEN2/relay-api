// Pages a site host shows when there is no site to show. They name no contractor, so they
// don't reveal whether one exists, and load nothing, so they work even when the database is down.

function systemPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; background: #f6f6f3; color: #16182b; font: 1.125rem/1.5 system-ui, sans-serif; text-align: center; }
</style>
</head>
<body>
<p>${message}</p>
</body>
</html>`
}

export const NOT_FOUND_PAGE = systemPage('Page not found', 'This page isn’t here.')
export const ERROR_PAGE = systemPage(
  'Something went wrong',
  'Something went wrong. Try again in a minute.',
)
