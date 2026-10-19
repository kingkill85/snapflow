// Package apperr defines the API error format.
//
// Every error carries a stable Code that the frontend uses as an i18n key, plus
// optional Params for interpolation. Detail is an English fallback for logs and
// API clients; the UI never shows it directly.
//
// Server errors (status 500 and above) never carry error text to the client:
// the cause is logged with the request id and the response has a fixed
// detail (Install, Internal).
package apperr

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5/middleware"
)

type Error struct {
	Status int            `json:"status" doc:"HTTP status code"`
	Code   string         `json:"code" doc:"Stable error code, used as i18n key" example:"function_type.not_found"`
	Detail string         `json:"detail,omitempty" doc:"English fallback message"`
	Params map[string]any `json:"params,omitempty" doc:"Values for the translated message"`
	Fields []FieldError   `json:"fields,omitempty" doc:"Per-field validation errors"`

	headers http.Header
}

type FieldError struct {
	Location string         `json:"location" doc:"Where the error occurred, e.g. body.key"`
	Code     string         `json:"code" doc:"Stable error code, used as i18n key"`
	Detail   string         `json:"detail,omitempty"`
	Params   map[string]any `json:"params,omitempty" doc:"Values for the translated message, e.g. {\"max\": 100}"`
}

// Field returns a field error without params.
func Field(location, code, detail string) FieldError {
	return FieldError{Location: location, Code: code, Detail: detail}
}

// With returns a copy of f with the param key set.
func (f FieldError) With(key string, value any) FieldError {
	params := make(map[string]any, len(f.Params)+1)
	for k, v := range f.Params {
		params[k] = v
	}
	params[key] = value
	f.Params = params
	return f
}

func (e *Error) Error() string  { return e.Detail }
func (e *Error) GetStatus() int { return e.Status }

// GetHeaders lets huma send extra response headers with the error.
func (e *Error) GetHeaders() http.Header { return e.headers }

// WithHeader adds a response header to the error.
func (e *Error) WithHeader(key, value string) *Error {
	if e.headers == nil {
		e.headers = http.Header{}
	}
	e.headers.Add(key, value)
	return e
}

// ContentType makes huma send errors as RFC 9457 problem documents.
func (e *Error) ContentType(ct string) string {
	if ct == "application/json" {
		return "application/problem+json"
	}
	return ct
}

func New(status int, code, detail string) *Error {
	return &Error{Status: status, Code: code, Detail: detail}
}

func (e *Error) With(key string, value any) *Error {
	if e.Params == nil {
		e.Params = map[string]any{}
	}
	e.Params[key] = value
	return e
}

func NotFound(code string) *Error { return New(http.StatusNotFound, code, "not found") }
func Conflict(code, detail string) *Error {
	return New(http.StatusConflict, code, detail)
}

// TooManyRequests reports a rate limit. The client learns the wait both as
// params.seconds (for the message) and as the Retry-After header.
func TooManyRequests(code, detail string, wait time.Duration) *Error {
	seconds := int(wait.Seconds()) + 1
	return New(http.StatusTooManyRequests, code, detail).
		With("seconds", seconds).
		WithHeader("Retry-After", strconv.Itoa(seconds))
}

// Invalid reports a single field validation error.
func Invalid(location, code, detail string) *Error {
	return &Error{
		Status: http.StatusUnprocessableEntity,
		Code:   "validation.failed",
		Detail: "validation failed",
		Fields: []FieldError{{Location: location, Code: code, Detail: detail}},
	}
}

// Validation reports several field validation errors at once, so a form can
// show all of them in one round trip.
func Validation(fields ...FieldError) *Error {
	return &Error{
		Status: http.StatusUnprocessableEntity,
		Code:   "validation.failed",
		Detail: "validation failed",
		Fields: fields,
	}
}

// internalDetail is the only detail a server error response carries.
const internalDetail = "internal server error"

// Internal logs err as a server error (with the request id) and returns a
// 500 that reveals nothing about it. msg says what failed, for the log.
func Internal(ctx context.Context, msg string, err error) *Error {
	if canceled(ctx, []error{err}) {
		slog.DebugContext(ctx, msg, "request_id", RequestID(ctx), "error", err)
		return &Error{Status: StatusClientClosedRequest, Code: "request.canceled", Detail: "request canceled"}
	}
	if cancelOther(ctx) {
		slog.WarnContext(ctx, "canceled request failed with another error", "request_id", RequestID(ctx), "message", msg, "error", err)
	}
	slog.ErrorContext(ctx, msg, "request_id", RequestID(ctx), "error", err)
	return New(http.StatusInternalServerError, "server.error", internalDetail)
}

// ConflictRetry reports a transaction that kept conflicting with concurrent
// ones (deadlock or serialization failure); trying again later works.
func ConflictRetry() *Error {
	return Conflict("request.conflict_retry", "a concurrent change conflicted with this request; try again")
}

// IsRetryable reports whether err is a Postgres deadlock (40P01) or
// serialization failure (40001): the transaction was aborted only because
// of a concurrent one and succeeds when run again.
func IsRetryable(err error) bool {
	var pg interface{ SQLState() string }
	if !errors.As(err, &pg) {
		return false
	}
	code := pg.SQLState()
	return code == "40P01" || code == "40001"
}

// RequestID returns the id chi's RequestID middleware gave the request ctx
// belongs to ("" outside a request).
func RequestID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	return middleware.GetReqID(ctx)
}

// Install replaces huma's error constructors so that framework errors
// (validation, unknown routes) and unexpected handler errors use the same
// format and codes. Server errors are logged and answered with a fixed
// detail; a deadlock or serialization failure that reached the handler
// becomes 409 request.conflict_retry instead of a 500.
func Install() {
	huma.NewErrorWithContext = func(hctx huma.Context, status int, msg string, errs ...error) huma.StatusError {
		ctx := context.Background()
		if hctx != nil {
			ctx = hctx.Context()
		}
		return newError(ctx, status, msg, errs...)
	}
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		return newError(context.Background(), status, msg, errs...)
	}
}

func newError(ctx context.Context, status int, msg string, errs ...error) *Error {
	if status >= http.StatusInternalServerError {
		for _, err := range errs {
			if IsRetryable(err) {
				return ConflictRetry()
			}
		}
		if canceled(ctx, errs) {
			// The client went away (reload, navigation): not a server error.
			slog.DebugContext(ctx, "request canceled", "request_id", RequestID(ctx), "error", errors.Join(errs...))
			return &Error{Status: StatusClientClosedRequest, Code: "request.canceled", Detail: "request canceled"}
		}
		if cancelOther(ctx) {
			slog.WarnContext(ctx, "canceled request failed with another error", "request_id", RequestID(ctx), "message", msg)
		}
		slog.ErrorContext(ctx, "server error", "request_id", RequestID(ctx), "status", status,
			"message", msg, "error", errors.Join(errs...))
		return &Error{Status: status, Code: codeForStatus(status), Detail: internalDetail}
	}
	e := &Error{Status: status, Code: codeForStatus(status), Detail: msg}
	for _, err := range errs {
		var detail *huma.ErrorDetail
		if errors.As(err, &detail) {
			e.Fields = append(e.Fields, FieldError{
				Location: detail.Location,
				Code:     "validation.invalid",
				Detail:   detail.Message,
			})
			continue
		}
		if err != nil {
			e.Fields = append(e.Fields, FieldError{Code: "validation.invalid", Detail: err.Error()})
		}
	}
	return e
}

// StatusClientClosedRequest is the status of a request the client aborted
// (nginx's 499); the client never sees it, the access log does.
const StatusClientClosedRequest = 499

// canceled reports whether errs come from the request's context being
// canceled (the client closed the connection): the context is done and an
// error says so. A canceled request that failed with another error is a
// real error (cancelOther).
func canceled(ctx context.Context, errs []error) bool {
	if ctx == nil || ctx.Err() == nil {
		return false
	}
	for _, err := range errs {
		if errors.Is(err, context.Canceled) {
			return true
		}
	}
	return false
}

// cancelOther reports a request whose context is canceled but that failed
// with an error other than the cancellation (logged as a warning besides
// the 500: it may hide a bug the cancellation only exposed).
func cancelOther(ctx context.Context) bool { return ctx != nil && ctx.Err() != nil }

func codeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "request.bad"
	case http.StatusUnauthorized:
		return "auth.required"
	case http.StatusForbidden:
		return "auth.forbidden"
	case http.StatusNotFound:
		return "request.not_found"
	case http.StatusConflict:
		return "request.conflict"
	case http.StatusUnprocessableEntity:
		return "validation.failed"
	default:
		if status >= 500 {
			return "server.error"
		}
		return "request.failed"
	}
}
