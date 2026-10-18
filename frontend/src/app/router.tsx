import { createBrowserRouter, Navigate } from 'react-router'

import { AppShell } from './AppShell'
import { features } from './features'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to={`/${features[0].path}`} replace /> },
      ...features.map((f) => ({ path: f.path, element: <f.element /> })),
    ],
  },
])
