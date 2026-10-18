package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

const (
	// CookieName holds the session token in the browser.
	CookieName = "snapflow_session"
	// SessionTTL is how long a session lives without being used.
	SessionTTL = 14 * 24 * time.Hour

	publicKey = "public"
)

// ErrInvalidSession means the token is unknown, expired, or belongs to an
// inactive user or tenant.
var ErrInvalidSession = errors.New("invalid session")

// Authenticator resolves a session token. renewed reports that the session's
// lifetime was extended, so the cookie must be sent again.
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (actor Actor, renewed bool, err error)
}

// Cookies builds the session cookie. Secure must only be off for plain-HTTP
// deployments; browsers accept secure cookies on http://localhost.
type Cookies struct {
	Secure bool
}

func (c Cookies) Session(token string) http.Cookie {
	return http.Cookie{
		Name: CookieName, Value: token, Path: "/",
		MaxAge: int(SessionTTL.Seconds()), HttpOnly: true, Secure: c.Secure, SameSite: http.SameSiteLaxMode,
	}
}

func (c Cookies) Clear() http.Cookie {
	return http.Cookie{
		Name: CookieName, Path: "/", MaxAge: -1, HttpOnly: true, Secure: c.Secure, SameSite: http.SameSiteLaxMode,
	}
}

// Public marks an operation as callable without login. Every other operation
// requires a valid session.
func Public(op huma.Operation) huma.Operation {
	if op.Metadata == nil {
		op.Metadata = map[string]any{}
	}
	op.Metadata[publicKey] = true
	op.Security = []map[string][]string{{}}
	return op
}

// SecuritySchemes documents the accepted credentials in the OpenAPI document.
func SecuritySchemes(o *huma.OpenAPI) {
	if o.Components.SecuritySchemes == nil {
		o.Components.SecuritySchemes = map[string]*huma.SecurityScheme{}
	}
	o.Components.SecuritySchemes["session"] = &huma.SecurityScheme{Type: "apiKey", In: "cookie", Name: CookieName}
	o.Components.SecuritySchemes["bearer"] = &huma.SecurityScheme{Type: "http", Scheme: "bearer"}
	o.Security = []map[string][]string{{"session": {}}, {"bearer": {}}}
}

// Middleware authenticates every request from the session cookie or a bearer
// token and rejects anonymous calls to non-public operations. Authorization
// (permissions, tenant boundaries) stays in the services.
func Middleware(api huma.API, authn Authenticator, cookies Cookies) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		token, fromCookie := credentials(ctx)
		authenticated := false
		if token != "" {
			actor, renewed, err := authn.Authenticate(ctx.Context(), token)
			switch {
			case err == nil:
				if fromCookie && crossSiteWrite(ctx) {
					_ = huma.WriteErr(api, ctx, http.StatusForbidden, "cross-site request refused")
					return
				}
				if renewed && fromCookie {
					c := cookies.Session(token)
					ctx.AppendHeader("Set-Cookie", c.String())
				}
				ctx = huma.WithContext(ctx, WithActor(ctx.Context(), actor))
				authenticated = true
			case errors.Is(err, ErrInvalidSession):
				if fromCookie {
					c := cookies.Clear()
					ctx.AppendHeader("Set-Cookie", c.String())
				}
			default:
				slog.ErrorContext(ctx.Context(), "authenticate", "error", err)
				_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "authentication failed")
				return
			}
		}
		if !authenticated && !isPublic(ctx.Operation()) {
			_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "login required")
			return
		}
		next(ctx)
	}
}

func credentials(ctx huma.Context) (token string, fromCookie bool) {
	if h := ctx.Header("Authorization"); h != "" {
		if t, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(t), false
		}
	}
	if c, err := huma.ReadCookie(ctx, CookieName); err == nil {
		return c.Value, true
	}
	return "", false
}

// crossSiteWrite refuses state-changing requests that a browser marks as
// coming from another site. SameSite=Lax already withholds the cookie there;
// this is the second line of CSRF defence.
func crossSiteWrite(ctx huma.Context) bool {
	switch ctx.Method() {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	site := ctx.Header("Sec-Fetch-Site")
	return site != "" && site != "same-origin" && site != "none"
}

func isPublic(op *huma.Operation) bool {
	public, _ := op.Metadata[publicKey].(bool)
	return public
}
