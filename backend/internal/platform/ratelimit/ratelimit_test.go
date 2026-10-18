package ratelimit

import (
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := New(2, time.Minute)
	l.now = func() time.Time { return now }

	for i := range 2 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("attempt %d refused", i+1)
		}
	}
	ok, wait := l.Allow("a")
	if ok || wait != time.Minute {
		t.Fatalf("third attempt: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("keys must be independent")
	}

	now = now.Add(time.Minute)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("new window refused")
	}
	l.Allow("a")
	l.Reset("a")
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("reset key refused")
	}
}
