import { describe, expect, it } from 'vitest'
import { escapeHtml, html, raw } from './html.ts'

describe('html', () => {
  it('escapes every value it is given', () => {
    expect(html`<p>${'<script>alert(1)</script>'}</p>`.text).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('keeps an attribute closed', () => {
    expect(html`<a title="${`" onclick="x' & y`}">`.text).toBe(
      '<a title="&quot; onclick=&quot;x&#39; &amp; y">',
    )
  })

  it('nests templates without escaping them twice', () => {
    expect(html`<ul>${html`<li>${'a&b'}</li>`}</ul>`.text).toBe('<ul><li>a&amp;b</li></ul>')
  })

  it('joins lists and leaves out empty values', () => {
    const items = ['x', 'y'].map((item) => html`<li>${item}</li>`)
    expect(html`${items}${null}${undefined}${false}${0}`.text).toBe('<li>x</li><li>y</li>0')
  })

  it('passes raw text through untouched', () => {
    expect(html`${raw('<b>ok</b>')}`.text).toBe('<b>ok</b>')
  })
})

it('escapeHtml covers the five special characters', () => {
  expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
})
