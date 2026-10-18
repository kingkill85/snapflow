package apperr_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

type pgError struct{ code string }

func (e *pgError) Error() string    { return "ERROR: deadlock detected (SQLSTATE " + e.code + ")" }
func (e *pgError) SQLState() string { return e.code }

// An unexpected error is logged, never sent: the 500 has a fixed detail and
// no fields.
func TestServerErrorsDoNotLeak(t *testing.T) {
	apperr.Install()
	secret := errors.New(`dial tcp 10.0.0.5:5432: password authentication failed for user "snapflow"`)
	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway} {
		e := huma.NewErrorWithContext(nil, status, "unexpected error occurred", secret)
		body, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		if e.GetStatus() != status || strings.Contains(string(body), "10.0.0.5") ||
			strings.Contains(string(body), "unexpected error occurred") || strings.Contains(string(body), "fields") {
			t.Errorf("%d: %s", status, body)
		}
		var got apperr.Error
		_ = json.Unmarshal(body, &got)
		if got.Code != "server.error" || got.Detail != "internal server error" {
			t.Errorf("%d: %s", status, body)
		}
	}
	// Client errors keep their details (they are about the request).
	e := huma.NewError(http.StatusUnprocessableEntity, "validation failed", &huma.ErrorDetail{Location: "body.x", Message: "expected string"})
	if body, _ := json.Marshal(e); !strings.Contains(string(body), "body.x") {
		t.Errorf("422 lost its fields: %s", body)
	}
}

// A deadlock or serialization failure that reaches a handler is 409
// request.conflict_retry, not a 500.
func TestRetryableBecomesConflict(t *testing.T) {
	apperr.Install()
	for _, code := range []string{"40P01", "40001"} {
		err := fmt.Errorf("delete product: %w", &pgError{code: code})
		if !apperr.IsRetryable(err) {
			t.Errorf("%s: not retryable", code)
		}
		e := huma.NewErrorWithContext(nil, http.StatusInternalServerError, "unexpected error occurred", err)
		if got, ok := e.(*apperr.Error); !ok || got.Status != http.StatusConflict || got.Code != "request.conflict_retry" {
			t.Errorf("%s: %+v", code, e)
		}
	}
	if apperr.IsRetryable(&pgError{code: "23505"}) || apperr.IsRetryable(errors.New("x")) {
		t.Error("other errors are not retryable")
	}
}
