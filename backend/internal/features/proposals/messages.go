package proposals

import (
	"fmt"
	"strings"
	"time"
)

// messages are the texts of a proposal per content language (the project's
// language, D253). English is the fallback.
var messages = map[string]map[string]string{
	"en": {
		"title":          "Proposal",
		"number":         "Proposal no.",
		"date":           "Date",
		"project":        "Project",
		"version":        "Version",
		"customer":       "Customer",
		"bom":            "Bill of materials",
		"pos":            "#",
		"description":    "Description",
		"quantity":       "Qty",
		"unitPrice":      "Unit price",
		"total":          "Total",
		"for":            "for %s",
		"otherItems":     "Other items",
		"subtotal":       "Subtotal",
		"discount":       "Discount",
		"grandTotal":     "Grand total",
		"net":            "All prices are net prices.",
		"converted":      "Prices are converted from USD at 1 USD = %s %s.",
		"zones":          "Devices per zone",
		"noZone":         "No zone",
		"plans":          "Plans",
		"legend":         "Legend",
		"existing":       "hatched: existing devices (not part of this proposal)",
		"existingCount":  "%d + %d existing",
		"planColumn":     "P%d",
		"planColumns":    "Quantities per plan",
		"category":       "Category",
		"page":           "Page {page} of {pages}",
		"model":          "Model %s",
		"sku":            "SKU %s",
		"amountCurrency": "%s (%s)",
	},
	"de": {
		"title":          "Angebot",
		"number":         "Angebotsnr.",
		"date":           "Datum",
		"project":        "Projekt",
		"version":        "Version",
		"customer":       "Kunde",
		"bom":            "Stückliste",
		"pos":            "Pos.",
		"description":    "Beschreibung",
		"quantity":       "Menge",
		"unitPrice":      "Einzelpreis",
		"total":          "Gesamt",
		"for":            "für %s",
		"otherItems":     "Weitere Positionen",
		"subtotal":       "Zwischensumme",
		"discount":       "Rabatt",
		"grandTotal":     "Gesamtsumme",
		"net":            "Alle Preise sind Nettopreise.",
		"converted":      "Die Preise sind aus USD umgerechnet zum Kurs 1 USD = %s %s.",
		"zones":          "Geräte je Zone",
		"noZone":         "Keine Zone",
		"plans":          "Pläne",
		"legend":         "Legende",
		"existing":       "schraffiert: vorhandene Geräte (nicht Teil dieses Angebots)",
		"existingCount":  "%d + %d vorhanden",
		"planColumn":     "P%d",
		"planColumns":    "Mengen je Plan",
		"category":       "Kategorie",
		"page":           "Seite {page} von {pages}",
		"model":          "Modell %s",
		"sku":            "Art.-Nr. %s",
		"amountCurrency": "%s (%s)",
	},
}

var months = map[string][]string{
	"en": {"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"},
	"de": {"Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"},
}

// tr is a text of lang (English when lang has none).
type tr string

func (l tr) t(key string, args ...any) string {
	m, ok := messages[string(l)]
	if !ok {
		m = messages["en"]
	}
	s, ok := m[key]
	if !ok {
		s = messages["en"][key]
	}
	if len(args) > 0 {
		return fmt.Sprintf(s, args...)
	}
	return s
}

// date formats a day for the language ("19 October 2026", "19. Oktober 2026").
func (l tr) date(t time.Time) string {
	if l == "de" {
		return fmt.Sprintf("%d. %s %d", t.Day(), months["de"][t.Month()-1], t.Year())
	}
	return fmt.Sprintf("%d %s %d", t.Day(), months["en"][t.Month()-1], t.Year())
}

// number formats a decimal string ("1234.5", "-3") with the language's
// separators: "1,234.50" in English, "1.234,50" in German. Negative values
// get a real minus sign.
func (l tr) number(s string) string {
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	whole, frac, _ := strings.Cut(s, ".")
	group, dec := ",", "."
	if l == "de" {
		group, dec = ".", ","
	}
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteString(group)
		}
		b.WriteRune(r)
	}
	out := b.String()
	if frac != "" {
		out += dec + frac
	}
	if neg {
		out = "−" + out
	}
	return out
}

// money formats an amount with its currency code ("1,234.50 EUR").
func (l tr) money(s, currency string) string { return l.number(s) + " " + currency }

// percent formats a percentage without trailing zero decimals ("10 %", "12,5 %").
func (l tr) percent(s string) string {
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return l.number(s) + " %"
}
