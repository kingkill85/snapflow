import { ChevronsDownUp, ChevronsUpDown, Plus } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { type FieldPath, useFieldArray, type UseFormReturn, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { useListCatalogFields } from '@/api/generated/catalog-fields/catalog-fields'
import { AttributeDefinitionItemType, AttributeDefinitionScope, AttributeDefinitionType, type CatalogField } from '@/api/generated/model'
import {
  Button,
  CheckboxField,
  ComboboxField,
  EmptyState,
  Field,
  FormSelectField,
  FormTranslatableField,
  type MoveAction,
  RepeaterControls,
  RepeaterItem,
  useFieldError,
  useRepeaterFocus,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import {
  copyAttribute,
  emptyAttribute,
  emptyOption,
  type FormValues,
  hasBounds,
  hasOptions,
  linkField,
  type SchemaName,
  wholeBounds,
} from './form'

type Form = UseFormReturn<FormValues>

type ErrorTree = { message?: string; root?: { message?: string } } | undefined

/** The translated error of a form field; field arrays carry theirs at "root". */
function useErrorAt(form: Form) {
  const fieldError = useFieldError()
  return (path: FieldPath<FormValues>) => {
    const error = form.getFieldState(path, form.formState).error as ErrorTree
    return fieldError(error?.message ?? error?.root?.message)
  }
}

/** Whether anything at or below a path has an error. */
const hasErrorAt = (form: Form, path: FieldPath<FormValues>) => form.getFieldState(path, form.formState).invalid

/** An error text without a field of its own (e.g. of a whole list): announced, and focusable for the jump to the first error. */
function ListError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" data-field-error tabIndex={-1} className="text-xs text-danger outline-none">
      {children}
    </p>
  )
}

type SchemaEditorProps = {
  form: Form
  name: SchemaName
  readOnly: boolean
  /** Rows loaded with the page start collapsed (editing an existing category); new rows always start expanded. */
  startCollapsed: boolean
  /** Increases with every save that failed validation: rows with errors open again. */
  errorRevision: number
}

/** Edits one attribute schema of a category: a list of attribute definitions. */
export function SchemaEditor({ form, name, readOnly, startCollapsed, errorRevision }: SchemaEditorProps) {
  const { t } = useTranslation('categories')
  const { t: tCommon } = useTranslation()
  const errorAt = useErrorAt(form)
  const { fields, insert, remove, move } = useFieldArray({ control: form.control, name })
  const focus = useRepeaterFocus(fields)
  const [loaded] = useState(() => new Set(startCollapsed ? fields.map((f) => f.id) : []))
  // Rows the user opened or closed; others follow `loaded`.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // The error revision at which the user last closed a row: a row with
  // errors stays open until the user closes it, and opens again on the next
  // failed save.
  const [closedAt, setClosedAt] = useState<Record<string, number>>({})

  const isOpen = (id: string, index: number) => {
    if (hasErrorAt(form, `${name}.${index}`) && (closedAt[id] ?? -1) < errorRevision) return true
    return expanded[id] ?? !loaded.has(id)
  }
  const setOpen = (ids: string[], open: boolean) => {
    setExpanded((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, open])) }))
    if (!open) setClosedAt((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, errorRevision])) }))
  }

  const add = (index: number, value = emptyAttribute()) => {
    insert(index, value)
    focus.added(index)
  }
  const onMove = (from: number, to: number, action: MoveAction) => {
    move(from, to)
    focus.moved(to, action)
  }
  const onRemove = (index: number) => {
    remove(index)
    focus.removed(index)
  }
  const onDuplicate = (index: number) => add(index + 1, copyAttribute(form.getValues(`${name}.${index}`)))

  const listError = errorAt(name)
  // Inactive fields stay listed: an attribute may still be linked to one.
  const catalogFields = useListCatalogFields({ includeInactive: true }).data?.items ?? []

  return (
    <div className="space-y-4">
      {/* Read-only, everything is shown: the disabled fieldset would disable the toggles too. */}
      {fields.length > 0 && !readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Long lists: adding without scrolling to the end. Adds at the top. */}
          <Button variant="secondary" size="sm" aria-label={t('schema.addFirst')} onClick={() => add(0)}>
            <Plus /> {t('schema.add')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(fields.map((f) => f.id), true)}>
            <ChevronsUpDown /> {tCommon('action.expandAll')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(fields.map((f) => f.id), false)}>
            <ChevronsDownUp /> {tCommon('action.collapseAll')}
          </Button>
        </div>
      )}
      {listError && <ListError>{listError}</ListError>}
      {fields.length === 0 && <EmptyState title={t('schema.empty')} />}
      {fields.map((field, index) => (
        <AttributeRow
          key={field.id}
          itemId={field.id}
          form={form}
          name={name}
          index={index}
          readOnly={readOnly}
          catalogFields={catalogFields}
          expanded={readOnly ? undefined : isOpen(field.id, index)}
          onExpandedChange={(open) => setOpen([field.id], open)}
          controls={
            readOnly ? undefined : (
              <RepeaterControls
                index={index}
                count={fields.length}
                name={t('schema.itemName', { n: index + 1 })}
                boundaryMoves
                onMove={onMove}
                onRemove={onRemove}
                onInsertBelow={(i) => add(i + 1)}
                onDuplicate={onDuplicate}
              />
            )
          }
        />
      ))}
      {!readOnly && (
        <Button data-repeater-add={focus.listId} variant="secondary" size="sm" onClick={() => add(fields.length)}>
          <Plus /> {t('schema.add')}
        </Button>
      )}
    </div>
  )
}

type AttributeRowProps = {
  /** The useFieldArray id (see useRepeaterFocus). */
  itemId: string
  form: Form
  name: SchemaName
  index: number
  readOnly: boolean
  catalogFields: CatalogField[]
  /** Undefined: not collapsible (read-only). */
  expanded?: boolean
  onExpandedChange: (expanded: boolean) => void
  controls?: ReactNode
}

function AttributeRow({ itemId, form, name, index, readOnly, catalogFields, expanded, onExpandedChange, controls }: AttributeRowProps) {
  const { t } = useTranslation('categories')
  const localized = useLocalized()
  const errorAt = useErrorAt(form)
  const path = `${name}.${index}` as const
  const [key, label, type, itemType, unit, required, scope, fieldKey] = useWatch({
    control: form.control,
    name: [
      `${path}.key`,
      `${path}.label`,
      `${path}.type`,
      `${path}.itemType`,
      `${path}.unit`,
      `${path}.required`,
      `${path}.scope`,
      `${path}.fieldKey`,
    ],
  })
  const register = form.register
  // A linked catalog field gives type, unit and options (D294); they are locked here.
  const linked = catalogFields.find((f) => f.key === fieldKey)
  const locked = fieldKey !== ''
  const fieldOptions = [
    { value: '', label: t('link.none') },
    ...catalogFields.map((f) => ({ value: f.key, label: `${localized(f.label)} (${f.key})` })),
    // A link to a field that is not listed (e.g. deleted since) stays visible.
    ...(fieldKey && !linked ? [{ value: fieldKey, label: fieldKey }] : []),
  ]
  const onLink = (value: string) => {
    const field = catalogFields.find((f) => f.key === value)
    form.setValue(path, linkField(form.getValues(path), field), { shouldDirty: true })
  }

  // Labels for min/max say what they limit for the chosen type.
  const boundsLabel = type === 'text' ? 'length' : type === 'list' ? 'items' : 'value'
  // The card is titled by the attribute's label (its key, or its position, while it has none) and
  // says what it defines: key · type · unit · required · scope (D114).
  const position = t('schema.item', { n: index + 1 })
  const title = localized(label).trim() || key.trim() || position
  const summary = [
    title !== key.trim() ? key.trim() : '',
    t(`type.${type}`),
    unit.trim(),
    fieldKey ? t('link.summary', { key: fieldKey }) : '',
    required ? t('field.required') : '',
    name === 'attributes' ? t(`scope.${scope}`) : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <RepeaterItem
      itemId={itemId}
      title={title}
      prefix={index + 1}
      groupLabel={title === position ? position : `${position}: ${title}`}
      name={t('schema.itemName', { n: index + 1 })}
      subtitle={summary}
      controls={controls}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      invalid={hasErrorAt(form, path)}
    >
      <div className="grid items-start gap-4 sm:grid-cols-3">
        <Field
          label={t('field.key')}
          hint={t('schema.keyHint')}
          required
          autoComplete="off"
          error={errorAt(`${path}.key`)}
          {...register(`${path}.key`)}
        />
        <div className="sm:col-span-2">
          <FormTranslatableField control={form.control} name={`${path}.label`} label={t('field.label')} required />
        </div>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-3">
        <ComboboxField
          label={t('field.catalogField')}
          hint={t('link.hint')}
          value={fieldKey}
          onValueChange={onLink}
          options={fieldOptions}
          disabled={readOnly}
          error={errorAt(`${path}.fieldKey`)}
        />
        {locked && (
          <div className="space-y-1.5 sm:col-span-2" data-testid="linked-meaning">
            <p className="text-sm font-medium">{t('link.meaning')}</p>
            <p className="text-sm text-muted">{linked?.meaning ? t(`meaning.${linked.meaning}`) : t('link.information')}</p>
          </div>
        )}
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-3">
        <FormSelectField
          control={form.control}
          name={`${path}.type`}
          label={t('field.type')}
          hint={locked ? t('link.locked') : undefined}
          disabled={locked}
          options={Object.values(AttributeDefinitionType).map((v) => ({ value: v, label: t(`type.${v}`) }))}
          error={errorAt(`${path}.type`)}
        />
        {type === 'list' && (
          <FormSelectField
            control={form.control}
            name={`${path}.itemType`}
            label={t('field.itemType')}
            options={Object.values(AttributeDefinitionItemType).map((v) => ({ value: v, label: t(`type.${v}`) }))}
            error={errorAt(`${path}.itemType`)}
          />
        )}
        {name === 'attributes' && (
          <FormSelectField
            control={form.control}
            name={`${path}.scope`}
            label={t('field.scope')}
            hint={t('scope.hint')}
            options={Object.values(AttributeDefinitionScope).map((v) => ({ value: v, label: t(`scope.${v}`) }))}
            error={errorAt(`${path}.scope`)}
          />
        )}
        <Field
          label={t('field.unit')}
          hint={t('field.unitHint')}
          readOnly={locked}
          error={errorAt(`${path}.unit`)}
          {...register(`${path}.unit`)}
        />
      </div>
      {hasBounds(type) && (
        <div className="grid gap-4 sm:grid-cols-3">
          {(['min', 'max'] as const).map((bound) => (
            // Text, so that anything typed reaches validation (a number input
            // would report invalid text as empty).
            <Field
              key={bound}
              label={t(`bounds.${boundsLabel}.${bound}`)}
              inputMode={wholeBounds(type) && type !== 'integer' ? 'numeric' : 'decimal'}
              autoComplete="off"
              error={errorAt(`${path}.${bound}`)}
              {...register(`${path}.${bound}`)}
            />
          ))}
        </div>
      )}
      <FormTranslatableField
        control={form.control}
        name={`${path}.description`}
        label={t('field.description')}
        hint={t('field.descriptionHint')}
        multiline
        rows={2}
      />
      <CheckboxField label={t('field.required')} hint={t('field.requiredHint')} {...register(`${path}.required`)} />
      {hasOptions(type, itemType) && <OptionsEditor form={form} path={path} readOnly={readOnly || locked} />}
    </RepeaterItem>
  )
}

type OptionsEditorProps = {
  form: Form
  path: `${SchemaName}.${number}`
  readOnly: boolean
}

/** The allowed values of an enum (or a list of enums). */
function OptionsEditor({ form, path, readOnly }: OptionsEditorProps) {
  const { t } = useTranslation('categories')
  const errorAt = useErrorAt(form)
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: `${path}.options` })
  const focus = useRepeaterFocus(fields)
  const titleId = useId()
  const errorId = useId()
  const error = errorAt(`${path}.options`)

  return (
    <div role="group" aria-labelledby={titleId} aria-describedby={error ? errorId : undefined} className="space-y-2">
      <p id={titleId} className="text-sm font-medium">
        {t('options.title')}
      </p>
      {error && <ListError id={errorId}>{error}</ListError>}
      {fields.map((field, j) => (
        <RepeaterItem
          key={field.id}
          itemId={field.id}
          compact
          title={t('options.item', { n: j + 1 })}
          invalid={hasErrorAt(form, `${path}.options.${j}`)}
          controls={
            readOnly ? undefined : (
              <RepeaterControls
                index={j}
                count={fields.length}
                name={t('options.itemName', { n: j + 1 })}
                onMove={(from, to, action) => {
                  move(from, to)
                  focus.moved(to, action)
                }}
                onRemove={(i) => {
                  remove(i)
                  focus.removed(i)
                }}
              />
            )
          }
        >
          <div className="grid items-start gap-3 sm:grid-cols-3">
            <Field
              label={t('field.key')}
              required
              autoComplete="off"
              error={errorAt(`${path}.options.${j}.key`)}
              {...form.register(`${path}.options.${j}.key`)}
            />
            <div className="sm:col-span-2">
              <FormTranslatableField control={form.control} name={`${path}.options.${j}.label`} label={t('field.label')} required />
            </div>
          </div>
        </RepeaterItem>
      ))}
      {!readOnly && (
        <Button
          data-repeater-add={focus.listId}
          variant="secondary"
          size="sm"
          onClick={() => {
            append(emptyOption())
            focus.added(fields.length)
          }}
        >
          <Plus /> {t('options.add')}
        </Button>
      )}
    </div>
  )
}
