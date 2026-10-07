# Framing: hosting to-do

relay-web refuses to show its pages inside another website, except the booking page (`/`) and
the manage page (`/manage/:token`), which the booking button on a contractor's site opens in a
popup (`relay-web/src/lib/framing.ts`). That check runs in the browser. When the hosting
configuration is set up (Render), also send this header on every path except `/`,
`/manage/*` and `/widget.js`:

    Content-Security-Policy: frame-ancestors 'self'
