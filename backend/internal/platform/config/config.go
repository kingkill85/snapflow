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
	// DatabaseMaxConns is the size of the connection pool (default 20).
	DatabaseMaxConns int32
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
	// StorageDir holds uploaded files (content-addressed). Keep it outside
	// the repository and back it up with the database.
	StorageDir string
	// ProposalGenerations is how many proposal generations run at once
	// (default 2); more wait briefly, then get 503 server.busy.
	ProposalGenerations int
	// ExchangeRateURL is the online exchange rate provider's endpoint
	// (open.er-api.com format; default exchangerate.DefaultURL).
	ExchangeRateURL string
	// ExchangeRateMaxAgeDays is when an online project rate counts as
	// stale (default 7).
	ExchangeRateMaxAgeDays int
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
		StorageDir:      getenv("STORAGE_DIR", "./data/files"),
	}
	maxConns, err := strconv.ParseInt(getenv("DATABASE_MAX_CONNS", "20"), 10, 32)
	if err != nil || maxConns < 2 {
		return c, errors.New("DATABASE_MAX_CONNS must be a number of at least 2")
	}
	c.DatabaseMaxConns = int32(maxConns)
	gens, err := strconv.Atoi(getenv("PROPOSAL_GENERATIONS", "2"))
	if err != nil || gens < 1 {
		return c, errors.New("PROPOSAL_GENERATIONS must be a number of at least 1")
	}
	c.ProposalGenerations = gens
	c.ExchangeRateURL = os.Getenv("EXCHANGE_RATE_URL")
	maxAge, err := strconv.Atoi(getenv("EXCHANGE_RATE_MAX_AGE_DAYS", "7"))
	if err != nil || maxAge < 1 {
		return c, errors.New("EXCHANGE_RATE_MAX_AGE_DAYS must be a number of at least 1")
	}
	c.ExchangeRateMaxAgeDays = maxAge
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
