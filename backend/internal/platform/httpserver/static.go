// Package httpserver serves the built frontend next to the API.
package httpserver

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

// MountSPA serves files from dir and falls back to index.html for client-side
// routes. Paths under /api are never handled here.
func MountSPA(r chi.Router, dir string) {
	files := http.FileServer(http.Dir(dir))
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		if strings.HasPrefix(req.URL.Path, "/api/") {
			http.NotFound(w, req)
			return
		}
		path := filepath.Join(dir, filepath.Clean("/"+req.URL.Path))
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			http.ServeFile(w, req, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, req)
	})
}
