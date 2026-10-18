import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { useLogoutAll } from '@/api/generated/auth/auth'
import { ConfirmDialog, ErrorMessage } from '@/components/ui'

/** Asks before ending every session, this one included; then on to the login page. Used by the profile page and the user menu. */
export function SignOutEverywhereDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('auth')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logoutAll = useLogoutAll()
  const { reset } = logoutAll

  // Each attempt starts without the previous one's error.
  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  const signOutEverywhere = async () => {
    try {
      await logoutAll.mutateAsync()
    } catch {
      return // shown by ErrorMessage via logoutAll.error
    }
    // This session ended too: forget everything cached for this user.
    queryClient.clear()
    void navigate('/login', { replace: true })
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('profile.signOutEverywhere')}
      message={t('profile.signOutEverywhereMessage')}
      confirmLabel={t('profile.signOutEverywhere')}
      pending={logoutAll.isPending}
      onConfirm={() => void signOutEverywhere()}
      error={<ErrorMessage error={logoutAll.error} />}
    />
  )
}
