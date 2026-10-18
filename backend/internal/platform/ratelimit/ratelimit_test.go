package ratelimit

import (
	"fmt"
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := New(2, time.Minute)
	l.now = func() time.Time { return now }

	for i := range 2 {
		if ok, _ := l.Check("a"); !ok {
			t.Fatalf("attempt %d refused", i+1)
		}
		l.Add("a")
	}
	ok, wait := l.Check("a")
	if ok || wait != time.Minute {
		t.Fatalf("third attempt: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Check("b"); !ok {
		t.Fatal("keys must be independent")
	}

	now = now.Add(time.Minute)
	if ok, _ := l.Check("a"); !ok {
		t.Fatal("new window refused")
	}
	l.Add("a")
	l.Add("a")
	l.Reset("a")
	if ok, _ := l.Check("a"); !ok {
		t.Fatal("reset key refused")
	}
}

func TestPrune(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := New(1, time.Minute)
	l.now = func() time.Time { return now }
	for i := range 100 {
		l.Add(fmt.Sprint(i))
	}
	now = now.Add(30 * time.Second)
	l.Check("x")
	if len(l.windows) != 100 {
		t.Fatalf("live windows pruned: %d left", len(l.windows))
	}
	now = now.Add(time.Minute)
	l.Check("x")
	if len(l.windows) != 0 {
		t.Fatalf("ended windows kept: %d left", len(l.windows))
	}
}
