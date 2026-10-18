import type { RouteObject } from 'react-router'

import { LoginPage } from '@/features/auth'

import { AppShell } from './AppShell'
import { NotFound, RouteError } from './errors'
import { features } from './features'
import { Home, RequireAuth, RequirePermission } from './guards'

export const routes: RouteObject[] = [
  {
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            path: '/',
            element: <AppShell />,
            children: [
              { index: true, element: <Home /> },
              ...features.flatMap((f) => [
                {
                  path: f.path,
                  element: (
                    <RequirePermission permission={f.permission}>
                      <f.element />
                    </RequirePermission>
                  ),
                },
                ...(f.pages ?? []).map((page) => ({
                  path: `${f.path}/${page.path}`,
                  element: (
                    <RequirePermission permission={f.permission}>
                      <RequirePermission permission={page.permission}>
                        <page.element />
                      </RequirePermission>
                    </RequirePermission>
                  ),
                })),
              ]),
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
]
