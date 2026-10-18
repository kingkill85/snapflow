// Package config loads runtime configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"

	"github.com/kingkill85/snapflow/backend/internal/platform/clientip"
)

type Config struct {
	Port        string
	DatabaseURL string
	// StaticDir holds the built frontend. Empty means the API is served alone.
	StaticDir string
	// CookieSecure marks the session cookie Secure. Turn it off only for
	// plain-HTTP deployments other than localhost.
	CookieSecure bool
	// DistributorName names the distributor tenant when it is first created.
	DistributorName string
	// AdminEmail and AdminPassword create the admin, or promote the existing
	// user with that email, when there is no active admin.
	AdminEmail    string
	AdminPassword string
	// TrustedProxies are the reverse proxies whose X-Forwarded-For header is
	// believed when determining the client address (login rate limits).
	TrustedProxies []netip.Prefix
}

func Load() (Config, error) {
	secure, err := strconv.ParseBool(getenv("COOKIE_SECURE", "true"))
	if err != nil {
		return Config{}, errors.New("COOKIE_SECURE must be true or false")
	}
	c := Config{
		Port:            getenv("PORT", "8000"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		StaticDir:       os.Getenv("STATIC_DIR"),
		CookieSecure:    secure,
		DistributorName: getenv("DISTRIBUTOR_NAME", "Distributor"),
		AdminEmail:      os.Getenv("ADMIN_EMAIL"),
		AdminPassword:   os.Getenv("ADMIN_PASSWORD"),
	}
	if c.TrustedProxies, err = clientip.ParseProxies(os.Getenv("TRUSTED_PROXIES")); err != nil {
		return c, fmt.Errorf("TRUSTED_PROXIES: %w", err)
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	if c.AdminEmail != "" && c.AdminPassword == "" {
		return c, errors.New("ADMIN_PASSWORD is required when ADMIN_EMAIL is set")
	}
	return c, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
