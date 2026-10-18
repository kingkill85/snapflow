// Package i18n holds translatable content types.
package i18n

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// DefaultLocale must always be present in a Text.
const DefaultLocale = "en"

// Locales are the languages SnapFlow speaks, DefaultLocale first. The
// frontend's language list (frontend/src/i18n/resources.ts) must match.
var Locales = []string{DefaultLocale, "de"}

// IsLocale reports whether l is one of Locales.
func IsLocale(l string) bool { return slices.Contains(Locales, l) }

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

// Check reports locales that are not in Locales (validation.locale) and,
// when maxRunes > 0, texts longer than maxRunes characters
// (validation.too_long, params.max), each at location + "." + locale, in
// locale order. Whether the default locale is required is up to the caller.
func (t Text) Check(location string, maxRunes int) []apperr.FieldError {
	locales := make([]string, 0, len(t))
	for l := range t {
		locales = append(locales, l)
	}
	sort.Strings(locales)
	var errs []apperr.FieldError
	for _, l := range locales {
		loc := location + "." + l
		switch {
		case !IsLocale(l):
			errs = append(errs, apperr.Field(loc, "validation.locale", "unknown locale"))
		case maxRunes > 0 && utf8.RuneCountInString(t[l]) > maxRunes:
			errs = append(errs, apperr.Field(loc, "validation.too_long",
				fmt.Sprintf("longer than %d characters", maxRunes)).With("max", maxRunes))
		}
	}
	return errs
}
