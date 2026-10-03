import { describe, expect, it } from 'vitest'
import { brandingAssetTypeOf, isUnsafeSvg, photoTypeOf, svgText } from './image-type.ts'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
])
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

describe('brandingAssetTypeOf', () => {
  it('recognises a PNG by its signature', () => {
    expect(brandingAssetTypeOf(PNG)).toBe('image/png')
  })

  it.each([
    ['a plain SVG', SVG],
    ['an SVG with an XML prolog', `<?xml version="1.0" encoding="UTF-8"?>\n${SVG}`],
    ['an SVG after a BOM and whitespace', `﻿ \n  ${SVG}`],
  ])('recognises %s', (_label, text) => {
    expect(brandingAssetTypeOf(Buffer.from(text))).toBe('image/svg+xml')
  })

  it.each([
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
    ['text that only mentions <svg later', Buffer.from('hello <svg></svg>')],
    ['an XML file without an svg element', Buffer.from('<?xml version="1.0"?><note/>')],
    ['bytes that are not UTF-8', Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe])],
    ['an empty file', Buffer.alloc(0)],
  ])('refuses %s', (_label, bytes) => {
    expect(brandingAssetTypeOf(bytes)).toBeNull()
  })

  it('leaves photo detection as it was', () => {
    expect(photoTypeOf(PNG)).toBe('image/png')
    expect(photoTypeOf(Buffer.from(SVG))).toBeNull()
  })
})

describe('svgText', () => {
  it('gives the text without the BOM and leading whitespace', () => {
    expect(svgText(Buffer.from(`﻿  ${SVG}`))).toBe(SVG)
  })

  it('is null for a PNG', () => {
    expect(svgText(PNG)).toBeNull()
  })
})

describe('isUnsafeSvg', () => {
  it.each([
    ['a script element', '<svg><script>alert(1)</script></svg>'],
    ['a script element in capitals', '<svg><SCRIPT>alert(1)</SCRIPT></svg>'],
    ['a foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['an event attribute', '<svg onload="alert(1)"></svg>'],
    ['an event attribute with spaces', '<svg><rect onclick = "x()"/></svg>'],
    ['a javascript: link', '<svg><a href="javascript:alert(1)"><rect/></a></svg>'],
    ['an external href', '<svg><image href="https://evil.test/x.png"/></svg>'],
    ['an external xlink:href', "<svg><use xlink:href='https://evil.test/s.svg#a'/></svg>"],
    ['an empty href', '<svg><use href=""/></svg>'],
  ])('refuses %s', (_label, text) => {
    expect(isUnsafeSvg(text)).toBe(true)
  })

  it.each([
    ['a plain SVG', SVG],
    [
      'an SVG with the xlink namespace and fragment links',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="a"/></defs><use xlink:href="#a"/><use href="#a"/></svg>',
    ],
    ['an embedded data image', '<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>'],
    ['a font attribute', '<svg><text font-family="Inter" font-size="4">Hi</text></svg>'],
  ])('accepts %s', (_label, text) => {
    expect(isUnsafeSvg(text)).toBe(false)
  })
})
