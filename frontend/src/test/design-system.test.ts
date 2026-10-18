import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

// Feature code must use the design system (src/components/ui) instead of raw
// interactive elements, so the same thing always looks the same.
const FORBIDDEN = ['button', 'input', 'select', 'textarea', 'table', 'dialog']
const src = join(import.meta.dirname, '..')
// Features and the shared catalog module (src/catalog) alike.
const roots = [join(src, 'features'), join(src, 'catalog')]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

describe('design system', () => {
  it('features use no raw interactive elements', () => {
    const violations = roots.flatMap(files).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return FORBIDDEN.filter((tag) => new RegExp(`<${tag}[\\s>]`).test(source)).map(
        (tag) => `${relative(src, path)}: <${tag}> — use the component from @/components/ui`,
      )
    })
    expect(violations).toEqual([])
  })
})
