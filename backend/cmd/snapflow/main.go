// Command snapflow runs the SnapFlow server.
//
//	snapflow serve     migrate, then serve the API (default)
//	snapflow migrate   apply migrations and exit
//	snapflow openapi   print the OpenAPI document (no database needed)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/app"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/config"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/exchangerate"
	"github.com/kingkill85/snapflow/backend/internal/platform/httpserver"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	if err := run(cmd); err != nil {
		slog.Error("snapflow failed", "command", cmd, "error", err)
		os.Exit(1)
	}
}

func run(cmd string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "serve":
		return serve(ctx)
	case "migrate":
		return migrate(ctx)
	case "openapi":
		return printOpenAPI()
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func migrate(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	return database.Migrate(ctx, cfg.DatabaseURL)
}

func serve(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := database.Migrate(ctx, cfg.DatabaseURL); err != nil {
		return err
	}
	pool, err := database.OpenWith(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := app.Bootstrap(ctx, pool, app.BootstrapConfig{
		DistributorName: cfg.DistributorName, AdminEmail: cfg.AdminEmail, AdminPassword: cfg.AdminPassword,
	}); err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}

	storage, err := files.NewStorage(cfg.StorageDir)
	if err != nil {
		return err
	}
	router, _ := app.New(app.Deps{
		DB: pool, Cookies: auth.Cookies{Secure: cfg.CookieSecure}, TrustedProxies: cfg.TrustedProxies,
		Storage: storage, ProposalGenerations: cfg.ProposalGenerations,
		ExchangeRates:          exchangerate.New(exchangerate.NewHTTP(cfg.ExchangeRateURL)),
		ExchangeRateMaxAgeDays: cfg.ExchangeRateMaxAgeDays,
	})
	if cfg.StaticDir != "" {
		httpserver.MountSPA(router, cfg.StaticDir)
	}

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: router, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("listening", "port", cfg.Port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func printOpenAPI() error {
	_, api := app.New(app.Deps{})
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(api.OpenAPI())
}
