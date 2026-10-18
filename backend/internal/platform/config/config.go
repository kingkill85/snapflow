// Package config loads runtime configuration from environment variables.
package config

import (
	"errors"
	"os"
)

type Config struct {
	Port        string
	DatabaseURL string
	// StaticDir holds the built frontend. Empty means the API is served alone.
	StaticDir string
}

func Load() (Config, error) {
	c := Config{
		Port:        getenv("PORT", "8000"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		StaticDir:   os.Getenv("STATIC_DIR"),
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	return c, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
