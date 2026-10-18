// Package ratelimit is a small in-memory fixed-window counter, enough for one
// instance (login attempts). Move to Postgres when running several instances.
//
// Callers check a key before an attempt and record only the events that
// count (e.g. failed logins), so legitimate use never fills a window.
package ratelimit

import (
	"sync"
	"time"
)

type window struct {
	start time.Time
	count int
}

type Limiter struct {
	limit  int
	period time.Duration
	now    func() time.Time

	mu        sync.Mutex
	windows   map[string]*window
	lastPrune time.Time
}

// New allows limit events per key and period.
func New(limit int, period time.Duration) *Limiter {
	return &Limiter{limit: limit, period: period, now: time.Now, windows: map[string]*window{}}
}

// Check reports whether key is below its limit without recording anything.
// When the limit is reached it returns false and how long until the window
// ends.
func (l *Limiter) Check(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybePrune(now)
	w, ok := l.windows[key]
	if !ok || now.Sub(w.start) >= l.period || w.count < l.limit {
		return true, 0
	}
	return false, w.start.Add(l.period).Sub(now)
}

// Add records one event for key.
func (l *Limiter) Add(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybePrune(now)
	w, ok := l.windows[key]
	if !ok || now.Sub(w.start) >= l.period {
		l.windows[key] = &window{start: now, count: 1}
		return
	}
	w.count++
}

// Reset forgets key, e.g. after a successful login.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.windows, key)
}

// maybePrune drops ended windows, at most once per period, so memory stays
// bounded without scanning the map on every call.
func (l *Limiter) maybePrune(now time.Time) {
	if now.Sub(l.lastPrune) < l.period {
		return
	}
	l.lastPrune = now
	for k, w := range l.windows {
		if now.Sub(w.start) >= l.period {
			delete(l.windows, k)
		}
	}
}
