package watts

import "testing"

func TestParse(t *testing.T) {
	for in, want := range map[string]string{"7.5": "7.50", "60": "60.00", "0.25": "0.25", "100000": "100000.00", "0": "0.00"} {
		if got, ok := Parse(in); !ok || got != want {
			t.Errorf("Parse(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "7.555", "-1", "1e3", "100000.01", "1,5", " 7", "1000000"} {
		if _, ok := Parse(in); ok {
			t.Errorf("Parse(%q) accepted", in)
		}
	}
}

func TestSum(t *testing.T) {
	var s Sum
	p := "0.10"
	for range 3 {
		s.Add(1, &p)
	}
	s.Add(5, nil)
	q := "7.55"
	s.Add(3, &q)
	if s.String() != "22.95" {
		t.Errorf("sum = %s, want 22.95", s.String())
	}
}
