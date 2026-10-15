// Markup the templates wrote themselves. Wrapping it in a class lets `html` tell its own output
// (kept as is) from contractor text (always escaped).
export class Html {
  readonly text: string

  constructor(text: string) {
    this.text = text
  }
}

export type HtmlValue = Html | string | number | boolean | null | undefined | HtmlValue[]

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

// Safe inside element text and inside quoted attributes.
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char])
}

// A template literal that escapes every value placed in it, e.g. html`<p>${review.body}</p>`.
// null, undefined and booleans render nothing, so `${show && html`...`}` works; lists are joined.
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let text = strings[0]
  values.forEach((value, index) => {
    text += render(value) + strings[index + 1]
  })
  return new Html(text)
}

// Text that is already safe markup. Only for what the code builds itself, never for contractor
// text: the JSON-LD block, after `<` is escaped.
export function raw(text: string): Html {
  return new Html(text)
}

function render(value: HtmlValue): string {
  if (value instanceof Html) return value.text
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  return escapeHtml(String(value))
}
