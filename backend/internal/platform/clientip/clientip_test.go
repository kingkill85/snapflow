package clientip

import "testing"

func TestResolve(t *testing.T) {
	trusted, err := ParseProxies(" 10.0.0.0/8, 192.0.2.1 ,")
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		remote string
		xff    []string
		want   string
	}{
		"direct":                   {"203.0.113.9:4000", nil, "203.0.113.9"},
		"untrusted sender ignored": {"203.0.113.9:4000", []string{"1.2.3.4"}, "203.0.113.9"},
		"trusted proxy":            {"192.0.2.1:4000", []string{"198.51.100.7"}, "198.51.100.7"},
		"spoofed left entries":     {"10.1.1.1:4000", []string{"6.6.6.6, 198.51.100.7"}, "198.51.100.7"},
		"proxy chain":              {"10.1.1.1:4000", []string{"198.51.100.7, 10.2.2.2", "10.3.3.3"}, "198.51.100.7"},
		"all trusted":              {"10.1.1.1:4000", []string{"10.2.2.2"}, "10.2.2.2"},
		"no header":                {"10.1.1.1:4000", nil, "10.1.1.1"},
		"ipv6":                     {"[2001:db8::1]:4000", nil, "2001:db8::1"},
	}
	for name, tc := range cases {
		if got := Resolve(trusted, tc.remote, tc.xff); got != tc.want {
			t.Errorf("%s: got %q, want %q", name, got, tc.want)
		}
	}
	if _, err := ParseProxies("not-an-ip"); err == nil {
		t.Error("invalid proxy accepted")
	}
}
