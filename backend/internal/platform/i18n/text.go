// Package i18n holds translatable content types.
package i18n

import "strings"

// DefaultLocale must always be present in a Text.
const DefaultLocale = "en"

// Text is a translatable string keyed by locale, e.g. {"en": "Dimmer", "de": "Dimmer"}.
// It is stored as jsonb.
type Text map[string]string

// Valid reports whether the default locale is present and not blank.
func (t Text) Valid() bool {
	return strings.TrimSpace(t[DefaultLocale]) != ""
}
