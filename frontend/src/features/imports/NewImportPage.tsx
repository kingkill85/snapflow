import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import { ApiError, apiClient } from '@/api/client'
import { getGetImportQueryKey, getListImportsQueryKey, useListImportProfiles } from '@/api/generated/imports/imports'
import type { ImportRun } from '@/api/generated/model'
import { Button, ErrorMessage, FileDrop, FormActions, Page, Section, SelectField, useErrorMessage } from '@/components/ui'

import { StepIndicator } from './StepIndicator'
import { checkImportFile, listPath, maxFileMb, runPath, type RunState } from './paths'

/** Uploads an import file (POST /api/imports) with progress, through the shared API client (as images, D69). */
function uploadImportFile(file: File, onProgress: (fraction: number) => void, signal: AbortSignal) {
  const data = new FormData()
  data.append('file', file)
  return apiClient<ImportRun>({
    url: '/api/imports',
    method: 'POST',
    data,
    signal,
    onUploadProgress: (e) => {
      if (e.total) onProgress(e.loaded / e.total)
    },
  })
}

/** catalog/imports/new: step 1, the file and optionally a profile. */
export function NewImportPage() {
  const { t } = useTranslation('imports')
  const { t: tCommon } = useTranslation()
  const message = useErrorMessage()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const profiles = useListImportProfiles()
  const [file, setFile] = useState<File>()
  const [profileId, setProfileId] = useState('')
  const [fileError, setFileError] = useState<unknown>(null)
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState<number>()
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])

  const choose = (chosen: File) => {
    setError(null)
    setFileError(checkImportFile(chosen) ?? null)
    setFile(chosen)
  }

  const upload = async () => {
    if (!file) {
      setFileError(new ApiError({ status: 422, code: 'validation.required' }))
      return
    }
    if (fileError) return
    const controller = new AbortController()
    running.current = controller
    setPending(true)
    setProgress(undefined)
    setError(null)
    try {
      const run = await uploadImportFile(file, setProgress, controller.signal)
      queryClient.setQueryData(getGetImportQueryKey(run.id), run)
      await queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() })
      // The run page previews with the profile at once, or shows the mapping.
      const state: RunState = profileId ? { profileId } : {}
      void navigate(runPath(run.id), { state })
    } catch (e) {
      if (!controller.signal.aborted) {
        if (e instanceof ApiError && ['import.file_type', 'import.too_large', 'import.unreadable', 'import.too_many_rows', 'import.too_many_images'].includes(e.code)) setFileError(e)
        else setError(e)
      }
    } finally {
      if (running.current === controller) running.current = null
      setPending(false)
    }
  }

  const profileOptions = [{ value: '', label: t('upload.noProfile') }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]

  return (
    <Page title={t('newTitle')} description={t('newDescription')}>
      <StepIndicator current="upload" />
      <Section title={t('upload.title')} description={t('upload.description')}>
        <FileDrop
          label={t('upload.file')}
          file={file}
          onSelect={choose}
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          hint={t('upload.hint', { maxMb: maxFileMb })}
          error={fileError ? message(fileError) : undefined}
          pending={pending}
          progress={progress}
        />
        <div className="max-w-md">
          <SelectField
            label={t('upload.profile')}
            hint={t('upload.profileHint')}
            value={profileId}
            onValueChange={setProfileId}
            options={profileOptions}
            disabled={pending || profiles.isPending}
          />
        </div>
        {profiles.isError && <ErrorMessage error={profiles.error} />}
      </Section>
      <FormActions error={<ErrorMessage error={error} />}>
        <Button asChild variant="secondary">
          <Link to={listPath}>{tCommon('action.cancel')}</Link>
        </Button>
        <Button onClick={() => void upload()} disabled={pending}>
          {profileId ? t('upload.submitPreview') : t('upload.submit')} <ArrowRight />
        </Button>
      </FormActions>
    </Page>
  )
}
