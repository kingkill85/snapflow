// Package clientip determines the address of the client that sent a request.
// Behind a reverse proxy the connection comes from the proxy, so the client is
// taken from X-Forwarded-For, but only when the connection comes from a
// trusted proxy: anyone else could put any address in that header.
package clientip

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// ParseProxies parses a comma-separated list of CIDRs or single addresses,
// e.g. the TRUSTED_PROXIES setting.
func ParseProxies(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if p, err := netip.ParsePrefix(part); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(part)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy %q: want a CIDR or an IP address", part)
		}
		out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
	}
	return out, nil
}

// Resolve returns the client address for a connection from remoteAddr
// ("host:port") carrying the given X-Forwarded-For header values. If the
// connection comes from a trusted proxy, the rightmost forwarded entry that
// is not itself a trusted proxy is the client.
func Resolve(trusted []netip.Prefix, remoteAddr string, forwardedFor []string) string {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	if !isTrusted(trusted, host) {
		return host
	}
	var entries []string
	for _, v := range forwardedFor {
		for _, e := range strings.Split(v, ",") {
			if e = strings.TrimSpace(e); e != "" {
				entries = append(entries, e)
			}
		}
	}
	client := host
	for i := len(entries) - 1; i >= 0; i-- {
		client = entries[i]
		if !isTrusted(trusted, client) {
			break
		}
	}
	return client
}

func isTrusted(trusted []netip.Prefix, host string) bool {
	a, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	a = a.Unmap()
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

type ctxKey struct{}

// Middleware stores the client address in the request context.
func Middleware(trusted []netip.Prefix) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := Resolve(trusted, r.RemoteAddr, r.Header.Values("X-Forwarded-For"))
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, ip)))
		})
	}
}

// FromContext returns the address stored by Middleware, or "" outside a request.
func FromContext(ctx context.Context) string {
	ip, _ := ctx.Value(ctxKey{}).(string)
	return ip
}
