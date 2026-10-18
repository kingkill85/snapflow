import { useTranslation } from 'react-i18next'

import type { ImportTarget } from '@/api/generated/model'
import type { ErrorKey } from '@/components/ui'
import { type LocalizedText, useLocalized } from '@/i18n/localized'

// Names in the import, in the UI language: targets, diff fields and error codes.

/** "English" for "en" (in the UI language), else the code. */
function useLanguageName() {
  const { t, i18n } = useTranslation('imports')
  return (code: string) => (i18n.exists(`languageName.${code}`, { ns: 'imports' }) ? t(`languageName.${code}` as 'languageName.en') : code)
}

/** Attribute labels by key, from the targets list. */
export type AttributeLabels = Map<string, LocalizedText>

export const attributeLabels = (targets: ImportTarget[] | undefined): AttributeLabels =>
  new Map((targets ?? []).flatMap((x) => (x.attribute ? [[x.attribute.key, x.attribute.label] as const] : [])))

/**
 * A mapping target's name, e.g. "Name (German)" for product.name.de or the
 * attribute's label for attribute.width_te.
 */
export function useTargetLabel(attributes: AttributeLabels) {
  const { t } = useTranslation('imports')
  const localized = useLocalized()
  const language = useLanguageName()
  return (target: string): string => {
    const [group, name, locale] = target.split('.')
    if (group === 'attribute') {
      const key = target.slice('attribute.'.length)
      const label = attributes.get(key)
      return label ? t('target.attributeNamed', { label: localized(label), key }) : t('target.attributeKey', { key })
    }
    if (locale) return t('target.localized', { name: t(`target.${group}.${name}` as 'target.product.name'), language: language(locale) })
    const key = `target.${group}.${name}`
    return t(key as 'target.product.modelNumber', { defaultValue: target })
  }
}

/** A diff field's name, e.g. "Description (English)" for description.en. */
export function useFieldLabel(attributes: AttributeLabels) {
  const { t } = useTranslation('imports')
  const localized = useLocalized()
  const language = useLanguageName()
  return (field: string): string => {
    if (field.startsWith('attributes.')) {
      const key = field.slice('attributes.'.length)
      const label = attributes.get(key)
      return label ? localized(label) : key
    }
    const [name, locale] = field.split('.')
    if (locale) return t('field.localized', { name: t(`field.${name}` as 'field.name'), language: language(locale) })
    return t(`field.${name}` as 'field.sku', { defaultValue: field })
  }
}

/** Translates an issue's or a failed run's error code with its params (unknown codes as "invalid"). */
export function useCodeMessage() {
  const { t, i18n } = useTranslation('errors')
  return (code: string, params?: Record<string, unknown>) =>
    String(i18n.exists(code, { ns: 'errors' }) ? t(code as ErrorKey, (params ?? {}) as never) : t('validation.invalid'))
}

