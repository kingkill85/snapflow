package i18n

import (
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestCheck(t *testing.T) {
	text := Text{"en": strings.Repeat("ä", 5), "de": strings.Repeat("x", 6), "fr": "x", "EN": "x"}
	got := []string{}
	for _, e := range text.Check("body.name", 5) {
		got = append(got, e.Location+" "+e.Code)
		if e.Code == "validation.too_long" && !reflect.DeepEqual(e.Params, map[string]any{"max": 5}) {
			t.Errorf("params: %v", e.Params)
		}
	}
	want := []string{"body.name.EN validation.locale", "body.name.de validation.too_long", "body.name.fr validation.locale"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
	if errs := (Text{"de": strings.Repeat("x", 500)}).Check("x", 0); len(errs) != 0 {
		t.Errorf("no length limit: %v", errs)
	}
	if errs := Text(nil).Check("x", 1); len(errs) != 0 {
		t.Errorf("nil: %v", errs)
	}
}

func TestLocales(t *testing.T) {
	if Locales[0] != DefaultLocale || !IsLocale("de") || IsLocale("fr") {
		t.Errorf("locales: %v", Locales)
	}
}

// The frontend's content locales (the TranslatableField tabs) must match Locales.
func TestLocalesMatchFrontend(t *testing.T) {
	src, err := os.ReadFile("../../../../frontend/src/i18n/content-locales.ts")
	if err != nil {
		t.Skipf("frontend not checked out: %v", err)
	}
	m := regexp.MustCompile(`export const contentLocales = \[([^\]]*)\]`).FindSubmatch(src)
	if m == nil {
		t.Fatal("contentLocales not found in content-locales.ts")
	}
	got := []string{}
	for _, l := range strings.Split(string(m[1]), ",") {
		got = append(got, strings.Trim(strings.TrimSpace(l), `'"`))
	}
	if !reflect.DeepEqual(got, Locales) {
		t.Errorf("frontend contentLocales %q, backend Locales %q", got, Locales)
	}
}
