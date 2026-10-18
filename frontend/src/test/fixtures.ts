import type { Me } from '@/api/generated/model'

/** The logged-in admin: every permission. */
export const adminMe: Me = {
  id: '00000000-0000-4000-8000-00000000000a',
  email: 'admin@example.com',
  fullName: 'Ada Admin',
  role: 'admin',
  tenantId: '00000000-0000-4000-8000-0000000000d1',
  tenantName: 'Distributor',
  permissions: [
    'catalog.read',
    'catalog.write',
    'projects.read',
    'projects.write',
    'projects.delete',
    'users.manage',
    'tenants.manage',
    'tenants.access_all',
  ],
  assignableRoles: ['admin', 'tenant_admin', 'user'],
}

export const tenantAdminMe: Me = {
  id: '00000000-0000-4000-8000-00000000000b',
  email: 'tina@acme.example',
  fullName: 'Tina Tenant',
  role: 'tenant_admin',
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  tenantName: 'Acme',
  permissions: ['catalog.read', 'projects.read', 'projects.write', 'projects.delete', 'users.manage'],
  assignableRoles: ['tenant_admin', 'user'],
}

export const userMe: Me = {
  id: '00000000-0000-4000-8000-00000000000c',
  email: 'uwe@acme.example',
  fullName: 'Uwe User',
  role: 'user',
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  tenantName: 'Acme',
  permissions: ['catalog.read', 'projects.read', 'projects.write'],
  assignableRoles: [],
}
