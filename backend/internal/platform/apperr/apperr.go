// Package apperr defines the API error format.
//
// Every error carries a stable Code that the frontend uses as an i18n key, plus
// optional Params for interpolation. Detail is an English fallback for logs and
// API clients; the UI never shows it directly.
package apperr

import (
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
)

type Error struct {
	Status int            `json:"status" doc:"HTTP status code"`
	Code   string         `json:"code" doc:"Stable error code, used as i18n key" example:"function_type.not_found"`
	Detail string         `json:"detail,omitempty" doc:"English fallback message"`
	Params map[string]any `json:"params,omitempty" doc:"Values for the translated message"`
	Fields []FieldError   `json:"fields,omitempty" doc:"Per-field validation errors"`
}

type FieldError struct {
	Location string `json:"location" doc:"Where the error occurred, e.g. body.key"`
	Code     string `json:"code" doc:"Stable error code, used as i18n key"`
	Detail   string `json:"detail,omitempty"`
}

func (e *Error) Error() string  { return e.Detail }
func (e *Error) GetStatus() int { return e.Status }

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

// Invalid reports a single field validation error.
func Invalid(location, code, detail string) *Error {
	return &Error{
		Status: http.StatusUnprocessableEntity,
		Code:   "validation.failed",
		Detail: "validation failed",
		Fields: []FieldError{{Location: location, Code: code, Detail: detail}},
	}
}

// Install replaces huma's error constructor so that framework errors
// (validation, unknown routes, panics) use the same format and codes.
func Install() {
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
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
}

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
