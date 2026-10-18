import './index.css'
import './i18n'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The DOM RouterProvider: navigations with flushSync (e.g. list filters) update at once.
import { RouterProvider } from 'react-router/dom'

import { createQueryClient } from './app/queryClient'
import { router } from './app/router'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
