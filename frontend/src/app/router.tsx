import { createBrowserRouter } from 'react-router'

import { LoginPage } from '@/features/auth'

import { AppShell } from './AppShell'
import { features } from './features'
import { Home, RequireAuth, RequirePermission } from './guards'

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [
          { index: true, element: <Home /> },
          ...features.map((f) => ({
            path: f.path,
            element: (
              <RequirePermission permission={f.permission}>
                <f.element />
              </RequirePermission>
            ),
          })),
        ],
      },
    ],
  },
])
