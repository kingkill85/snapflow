import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { type FieldPath, useFieldArray, type UseFormReturn, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { AttributeDefinitionItemType, AttributeDefinitionScope, AttributeDefinitionType } from '@/api/generated/model'
import { Button, CheckboxField, EmptyState, Field, RepeaterControls, RepeaterItem, SelectField, useFieldError } from '@/components/ui'

import { emptyAttribute, emptyOption, type FormValues, hasBounds, hasOptions, type SchemaName } from './form'

type Form = UseFormReturn<FormValues>

/** The translated error of a form field; array fields carry theirs at "root". */
function useErrorAt(form: Form) {
  const fieldError = useFieldError()
  return (path: FieldPath<FormValues>) => {
    const error = form.getFieldState(path, form.formState).error as { message?: string; root?: { message?: string } } | undefined
    return fieldError(error?.message ?? error?.root?.message)
  }
}

type SchemaEditorProps = {
  form: Form
  name: SchemaName
  readOnly: boolean
}

/** Edits one attribute schema of a product type: a list of attribute definitions. */
export function SchemaEditor({ form, name, readOnly }: SchemaEditorProps) {
  const { t } = useTranslation('productTypes')
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name })

  return (
    <div className="space-y-4">
      {fields.length === 0 && <EmptyState title={t('schema.empty')} />}
      {fields.map((field, index) => (
        <AttributeRow
          key={field.id}
          form={form}
          name={name}
          index={index}
          readOnly={readOnly}
          controls={readOnly ? undefined : <RepeaterControls index={index} count={fields.length} onMove={move} onRemove={remove} />}
        />
      ))}
      {!readOnly && (
        <Button variant="secondary" size="sm" onClick={() => append(emptyAttribute())}>
          <Plus /> {t('schema.add')}
        </Button>
      )}
    </div>
  )
}

type AttributeRowProps = {
  form: Form
  name: SchemaName
  index: number
  readOnly: boolean
  controls?: ReactNode
}

function AttributeRow({ form, name, index, readOnly, controls }: AttributeRowProps) {
  const { t } = useTranslation('productTypes')
  const errorAt = useErrorAt(form)
  const path = `${name}.${index}` as const
  const [key, type, itemType] = useWatch({ control: form.control, name: [`${path}.key`, `${path}.type`, `${path}.itemType`] })
  const register = form.register

  // Labels for min/max say what they limit for the chosen type.
  const boundsLabel = type === 'text' ? 'length' : type === 'list' ? 'items' : 'value'

  return (
    <RepeaterItem title={t('schema.item', { n: index + 1 })} subtitle={key} controls={controls}>
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
          <Field
            label={t(`bounds.${boundsLabel}.min`)}
            type="number"
            step="any"
            error={errorAt(`${path}.min`)}
            {...register(`${path}.min`)}
          />
          <Field
            label={t(`bounds.${boundsLabel}.max`)}
            type="number"
            step="any"
            error={errorAt(`${path}.max`)}
            {...register(`${path}.max`)}
          />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('field.descriptionEn')} error={errorAt(`${path}.description.en`)} {...register(`${path}.description.en`)} />
        <Field label={t('field.descriptionDe')} error={errorAt(`${path}.description.de`)} {...register(`${path}.description.de`)} />
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
  const error = errorAt(`${path}.options`)

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('options.title')}</p>
      {error && <p className="text-xs text-danger">{error}</p>}
      {fields.map((field, j) => (
        <RepeaterItem
          key={field.id}
          compact
          title={t('options.item', { n: j + 1 })}
          controls={readOnly ? undefined : <RepeaterControls index={j} count={fields.length} onMove={move} onRemove={remove} />}
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
        <Button variant="secondary" size="sm" onClick={() => append(emptyOption())}>
          <Plus /> {t('options.add')}
        </Button>
      )}
    </div>
  )
}
