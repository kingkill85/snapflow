import { describe, expect, it } from 'vitest'

import { isCanvasKeyTarget } from './keyboard'

function element(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host.querySelector('[data-target]') ?? host.firstElementChild!
}

describe('plain keys on the canvas', () => {
  it('act when focus is on the page, the canvas container or a non-interactive element', () => {
    expect(isCanvasKeyTarget(document.body)).toBe(true)
    expect(isCanvasKeyTarget(window)).toBe(true)
    expect(isCanvasKeyTarget(element('<div tabindex="0">canvas</div>'))).toBe(true)
    expect(isCanvasKeyTarget(element('<p><span data-target>text</span></p>'))).toBe(true)
  })

  it('never act when focus is on a control that uses the key', () => {
    for (const html of [
      '<button>Undo</button>',
      '<a href="/x">Back</a>',
      '<input type="checkbox" />',
      '<input type="text" />',
      '<select><option>a</option></select>',
      '<textarea></textarea>',
      '<div contenteditable="true">x</div>',
      '<button role="switch">On</button>',
      '<div role="tab" tabindex="0">Zones</div>',
      '<div role="checkbox" tabindex="0">x</div>',
      '<div role="radio" tabindex="0">x</div>',
      '<div role="menuitem" tabindex="0">x</div>',
      '<div role="option" tabindex="0">x</div>',
      '<button><svg data-target></svg></button>',
    ]) {
      expect(isCanvasKeyTarget(element(html)), html).toBe(false)
    }
  })
})
