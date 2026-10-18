import { ChevronsDownUp, ChevronsUpDown, Plus } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { type FieldPath, useFieldArray, type UseFormReturn, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { AttributeDefinitionItemType, AttributeDefinitionScope, AttributeDefinitionType } from '@/api/generated/model'
import {
  Button,
  CheckboxField,
  EmptyState,
  Field,
  type MoveAction,
  RepeaterControls,
  RepeaterItem,
  SelectField,
  TextareaField,
  useFieldError,
  useRepeaterFocus,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { copyAttribute, emptyAttribute, emptyOption, type FormValues, hasBounds, hasOptions, type SchemaName, wholeBounds } from './form'

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
  /** Rows loaded with the page start collapsed (editing an existing type); new rows always start expanded. */
  startCollapsed: boolean
  /** Increases with every save that failed validation: rows with errors open again. */
  errorRevision: number
}

/** Edits one attribute schema of a product type: a list of attribute definitions. */
export function SchemaEditor({ form, name, readOnly, startCollapsed, errorRevision }: SchemaEditorProps) {
  const { t } = useTranslation('productTypes')
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
  /** Undefined: not collapsible (read-only). */
  expanded?: boolean
  onExpandedChange: (expanded: boolean) => void
  controls?: ReactNode
}

function AttributeRow({ itemId, form, name, index, readOnly, expanded, onExpandedChange, controls }: AttributeRowProps) {
  const { t } = useTranslation('productTypes')
  const localized = useLocalized()
  const errorAt = useErrorAt(form)
  const path = `${name}.${index}` as const
  const [key, label, type, itemType, unit, required, scope] = useWatch({
    control: form.control,
    name: [`${path}.key`, `${path}.label`, `${path}.type`, `${path}.itemType`, `${path}.unit`, `${path}.required`, `${path}.scope`],
  })
  const register = form.register

  // Labels for min/max say what they limit for the chosen type.
  const boundsLabel = type === 'text' ? 'length' : type === 'list' ? 'items' : 'value'
  // Collapsed rows show what they define: Label · type · unit · required · scope.
  const summary = [
    localized(label) || key,
    t(`type.${type}`),
    unit.trim(),
    required ? t('field.required') : '',
    name === 'attributes' ? t(`scope.${scope}`) : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <RepeaterItem
      itemId={itemId}
      title={t('schema.item', { n: index + 1 })}
      name={t('schema.itemName', { n: index + 1 })}
      subtitle={expanded === false ? summary : key}
      controls={controls}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      invalid={hasErrorAt(form, path)}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('field.key')} hint={t('schema.keyHint')} error={errorAt(`${path}.key`)} {...register(`${path}.key`)} />
        <Field label={t('field.labelEn')} error={errorAt(`${path}.label.en`)} {...register(`${path}.label.en`)} />
        <Field label={t('field.labelDe')} error={errorAt(`${path}.label.de`)} {...register(`${path}.label.de`)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          label={t('field.type')}
          options={Object.values(AttributeDefinitionType).map((v) => ({ value: v, label: t(`type.${v}`) }))}
          error={errorAt(`${path}.type`)}
          {...register(`${path}.type`)}
        />
        {type === 'list' && (
          <SelectField
            label={t('field.itemType')}
            options={Object.values(AttributeDefinitionItemType).map((v) => ({ value: v, label: t(`type.${v}`) }))}
            error={errorAt(`${path}.itemType`)}
            {...register(`${path}.itemType`)}
          />
        )}
        {name === 'attributes' && (
          <SelectField
            label={t('field.scope')}
            hint={t('scope.hint')}
            options={Object.values(AttributeDefinitionScope).map((v) => ({ value: v, label: t(`scope.${v}`) }))}
            error={errorAt(`${path}.scope`)}
            {...register(`${path}.scope`)}
          />
        )}
        <Field label={t('field.unit')} hint={t('field.unitHint')} error={errorAt(`${path}.unit`)} {...register(`${path}.unit`)} />
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
      <div className="grid gap-4 sm:grid-cols-2">
        <TextareaField
          label={t('field.descriptionEn')}
          rows={2}
          error={errorAt(`${path}.description.en`)}
          {...register(`${path}.description.en`)}
        />
        <TextareaField
          label={t('field.descriptionDe')}
          rows={2}
          error={errorAt(`${path}.description.de`)}
          {...register(`${path}.description.de`)}
        />
      </div>
      <CheckboxField label={t('field.required')} hint={t('field.requiredHint')} {...register(`${path}.required`)} />
      {hasOptions(type, itemType) && <OptionsEditor form={form} path={path} readOnly={readOnly} />}
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
  const { t } = useTranslation('productTypes')
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
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('field.key')} error={errorAt(`${path}.options.${j}.key`)} {...form.register(`${path}.options.${j}.key`)} />
            <Field
              label={t('field.labelEn')}
              error={errorAt(`${path}.options.${j}.label.en`)}
              {...form.register(`${path}.options.${j}.label.en`)}
            />
            <Field
              label={t('field.labelDe')}
              error={errorAt(`${path}.options.${j}.label.de`)}
              {...form.register(`${path}.options.${j}.label.de`)}
            />
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
