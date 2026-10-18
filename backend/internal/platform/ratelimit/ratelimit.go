// Package ratelimit is a small in-memory fixed-window limiter, enough for one
// instance (login attempts). Move to Postgres when running several instances.
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

	mu      sync.Mutex
	windows map[string]*window
}

// New allows limit events per key and period.
func New(limit int, period time.Duration) *Limiter {
	return &Limiter{limit: limit, period: period, now: time.Now, windows: map[string]*window{}}
}

// Allow records an event for key. When the limit is reached it returns false
// and how long until the next event is allowed.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.windows) > 10_000 {
		l.prune(now)
	}
	w, ok := l.windows[key]
	if !ok || now.Sub(w.start) >= l.period {
		l.windows[key] = &window{start: now, count: 1}
		return true, 0
	}
	if w.count >= l.limit {
		return false, w.start.Add(l.period).Sub(now)
	}
	w.count++
	return true, 0
}

// Reset forgets key, e.g. after a successful login.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.windows, key)
}

func (l *Limiter) prune(now time.Time) {
	for k, w := range l.windows {
		if now.Sub(w.start) >= l.period {
			delete(l.windows, k)
		}
	}
}
