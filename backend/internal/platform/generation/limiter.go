// Package generation bounds the document generations that run at once
// (D268): proposals and installation documents share one Limiter, so
// PROPOSAL_GENERATIONS is the limit for all of them together.
package generation

import (
	"context"
	"net/http"
	"time"

	"golang.org/x/sync/semaphore"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// Default is the number of generations at once when nothing is configured.
const Default = 2

// Limiter holds a slot per running generation.
type Limiter struct {
	slots *semaphore.Weighted
	// Wait is how long a generation waits for a slot before 503 server.busy.
	Wait time.Duration
}

// New returns a limiter of n slots (at least 1).
func New(n int) *Limiter {
	return &Limiter{slots: semaphore.NewWeighted(int64(max(n, 1))), Wait: 5 * time.Second}
}

// Acquire takes a slot, waiting at most l.Wait; release it with the
// returned function. A full limiter answers 503 server.busy.
func (l *Limiter) Acquire(ctx context.Context) (func(), error) {
	wait, cancel := context.WithTimeout(ctx, l.Wait)
	defer cancel()
	if err := l.slots.Acquire(wait, 1); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, apperr.New(http.StatusServiceUnavailable, "server.busy", "server busy, try again shortly")
	}
	return func() { l.slots.Release(1) }, nil
}
