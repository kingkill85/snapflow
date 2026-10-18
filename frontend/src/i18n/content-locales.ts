// The languages translatable catalog content (i18n.Text) can be written in,
// the default first: one tab each in every TranslatableField (D109). This is
// the backend's i18n.Locales (TestLocalesMatchFrontend reads this line) and is
// independent of the UI languages in resources.ts: content can be kept in a
// language the interface is not translated into, and the other way round.
export const contentLocales = ['en', 'de'] as const
export type ContentLocale = (typeof contentLocales)[number]
