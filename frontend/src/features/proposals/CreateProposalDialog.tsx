import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { NullableFreeTextShare, NullableSnapshotProductType, PreviewDocument, PreviewInput, Proposal } from '@/api/generated/model'
import { previewProposals, useGenerateProposals, useListExporters } from '@/api/generated/proposals/proposals'
import { CheckboxGroupField, DataTable, errorKey, ErrorMessage, FormDialog, Loading, SelectField, TypeBadge, useFieldError } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { startDownloads, useFormatAmount, useFormatGrandTotal } from './format'

type ProductType = NonNullable<NullableSnapshotProductType>
type Mode = 'combined' | 'split'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionId: string
  /** The product types that have lines in the BOM (its groups), in BOM order. */
  productTypes: ProductType[]
  onCreated: (proposals: Proposal[]) => void
}

/**
 * Create proposal: the format (only the API's exporters), one combined
 * document or one per chosen product type, and the totals of each document
 * from the preview endpoint (debounced; the frontend computes nothing, rule 1).
 * Created files download right away, several one after another (the
 * notice in the tab links each of them too).
 */
export function CreateProposalDialog({ open, onOpenChange, versionId, productTypes, onCreated }: Props) {
  const { t } = useTranslation('proposals')
  const { t: tCommon } = useTranslation()
  const localize = useLocalized()
  const fieldError = useFieldError()
  const exporters = useListExporters({ query: { enabled: open } })
  const generate = useGenerateProposals()
  // Mounted per opening (ProposalsTab), so every opening starts combined with every product type ticked for a split.
  const [exporter, setExporter] = useState('')
  const [mode, setMode] = useState<Mode>('combined')
  const [typeIds, setTypeIds] = useState<string[]>(() => productTypes.map((p) => p.id))
  const [typesError, setTypesError] = useState(false)
  const exporterOptions = (exporters.data ?? []).map((e) => ({ value: e.key, label: localize(e.name) }))
  // Undefined until the exporters have loaded: creating waits for them and never sends an empty format.
  const chosenExporter: string | undefined = exporterOptions.some((o) => o.value === exporter) ? exporter : exporterOptions[0]?.value

  const split = mode === 'split'
  const input: PreviewInput | undefined = split ? (typeIds.length > 0 ? { split: true, productTypeIds: typeIds } : undefined) : { split: false }
  const preview = usePreview(versionId, input, open)

  const submit = async () => {
    if (!chosenExporter) return
    if (split && typeIds.length === 0) {
      setTypesError(true)
      return
    }
    let created: Proposal[]
    try {
      created = await generate.mutateAsync({ versionId, data: { exporter: chosenExporter, ...(split ? { split: true, productTypeIds: typeIds } : { split: false }) } })
    } catch {
      return // shown by ErrorMessage via generate.error
    }
    onOpenChange(false)
    onCreated(created)
    startDownloads(created.map((p) => p.downloadUrl))
  }

  const documentName = (d: PreviewDocument) => {
    if (!d.productType) return t('combined')
    const type = productTypes.find((p) => p.id === d.productType?.id)
    return (
      <TypeBadge color={type?.color} abbreviation={type?.abbreviation} wrap>
        {localize(d.productType.name)}
      </TypeBadge>
    )
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('dialog.title')}
      submitLabel={tCommon('action.create')}
      submitting={generate.isPending}
      submitDisabled={!chosenExporter}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={generate.error} />}
    >
      {exporters.isError ? (
        <ErrorMessage error={exporters.error} />
      ) : exporters.isPending ? (
        <Loading />
      ) : (
        <SelectField label={t('dialog.format')} required value={chosenExporter ?? ''} options={exporterOptions} onValueChange={setExporter} />
      )}
      <SelectField
        label={t('dialog.documents')}
        value={mode}
        options={[
          { value: 'combined', label: t('dialog.combined') },
          { value: 'split', label: t('dialog.split') },
        ]}
        onValueChange={(v) => setMode(v as Mode)}
        hint={split ? t('dialog.splitHint') : undefined}
      />
      {split && (
        <CheckboxGroupField
          label={t('dialog.productTypes')}
          required
          options={productTypes.map((p) => ({
            value: p.id,
            label: localize(p.name),
            content: (
              <TypeBadge color={p.color} abbreviation={p.abbreviation}>
                {localize(p.name)}
              </TypeBadge>
            ),
          }))}
          value={typeIds}
          onChange={(v) => {
            setTypeIds(v)
            if (v.length > 0) setTypesError(false)
          }}
          error={typesError ? fieldError(errorKey('proposal.product_types_required')) : undefined}
          hint={productTypes.length === 0 ? t('dialog.noProductTypes') : undefined}
        />
      )}
      <div className="space-y-2" aria-busy={preview.pending || undefined}>
        <h3 className="text-sm font-medium">{t('dialog.preview')}</h3>
        {preview.error ? (
          <ErrorMessage error={preview.error} />
        ) : !input ? (
          <p className="text-sm text-muted">{t('dialog.previewNone')}</p>
        ) : !preview.data ? (
          <Loading />
        ) : (
          <div className={cn(preview.pending && 'opacity-60')}>
            <PreviewTable documents={preview.data.documents} documentName={documentName} />
            {preview.data.freeText && <FreeTextRow share={preview.data.freeText} currency={preview.data.documents[0]?.totals.currency ?? 'USD'} />}
          </div>
        )}
      </div>
    </FormDialog>
  )
}

function PreviewTable({ documents, documentName }: { documents: PreviewDocument[]; documentName: (d: PreviewDocument) => ReactNode }) {
  const { t } = useTranslation('proposals')
  const grandTotal = useFormatGrandTotal()
  return (
    <DataTable
      flat
      label={t('dialog.preview')}
      rows={documents}
      rowKey={(d) => d.productType?.id ?? 'combined'}
      columns={[
        { header: t('column.type'), cell: documentName, mobile: 'title' },
        { header: t('column.grandTotal'), cell: (d) => <span data-testid="preview-total">{grandTotal(d.totals)}</span>, className: 'whitespace-nowrap text-right tabular-nums' },
      ]}
      empty={null}
    />
  )
}

/** A split leaves the free-text lines out of every document: their share, which only the combined proposal has. */
function FreeTextRow({ share, currency }: { share: NonNullable<NullableFreeTextShare>; currency: string }) {
  const { t } = useTranslation('proposals')
  const amount = useFormatAmount()
  return (
    <p className="mt-2 text-sm text-muted" data-testid="preview-free-text">
      {t('dialog.freeText', { total: amount(share.grandTotal, share.converted, currency) })}
    </p>
  )
}

/** The preview of the documents for the choices, 400 ms after the last change. */
function usePreview(versionId: string, input: PreviewInput | undefined, open: boolean) {
  const key = JSON.stringify(input ?? null)
  const [debounced, setDebounced] = useState(key)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(key), 400)
    return () => clearTimeout(timer)
  }, [key])
  const body = JSON.parse(debounced) as PreviewInput | null
  const query = useQuery({
    queryKey: ['proposal-preview', versionId, debounced],
    queryFn: ({ signal }) => previewProposals(versionId, body!, signal),
    enabled: open && body !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: false,
  })
  return { data: query.data, error: query.isError ? query.error : null, pending: query.isFetching || debounced !== key }
}
