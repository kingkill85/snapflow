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

// Trimmed returns t with values trimmed and blank locales removed; nil stays
// nil.
func (t Text) Trimmed() Text {
	if t == nil {
		return nil
	}
	out := Text{}
	for lang, v := range t {
		if v = strings.TrimSpace(v); v != "" {
			out[lang] = v
		}
	}
	return out
}
