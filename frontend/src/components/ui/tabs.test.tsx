import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { Tabs } from './tabs'

function Demo() {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
  return (
    <Tabs
      label="Panel"
      value={value}
      onValueChange={setValue}
      tabs={[
        { key: 'a', label: 'One', content: 'First' },
        { key: 'b', label: 'Two', content: 'Second' },
        { key: 'c', label: 'Three', content: 'Third' },
      ]}
    />
  )
}

describe('Tabs', () => {
  it('shows the active panel and moves with clicks and arrow keys', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    expect(screen.getByRole('tablist', { name: 'Panel' })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel', { name: 'One' })).toHaveTextContent('First')
    await user.click(screen.getByRole('tab', { name: 'Two' }))
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Two' })).toHaveTextContent('Second')
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Third')
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('First')
    await user.keyboard('{End}')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Third')
  })
})
