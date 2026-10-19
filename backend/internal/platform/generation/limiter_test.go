package generation

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// A full limiter answers 503 server.busy after a short wait.
func TestBusy(t *testing.T) {
	l := New(1)
	l.Wait = 50 * time.Millisecond
	release, err := l.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = l.Acquire(context.Background())
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Status != http.StatusServiceUnavailable || ae.Code != "server.busy" {
		t.Errorf("busy: %v", err)
	}
	release()
	r, err := l.Acquire(context.Background())
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	r()
}
