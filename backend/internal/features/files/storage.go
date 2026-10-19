package files

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

var sumPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Storage keeps file contents on disk, addressed by their SHA-256 (hex) and
// sharded by its first two byte pairs: <dir>/ab/cd/abcd….
type Storage struct {
	dir string
}

// NewStorage returns the storage under dir, creating dir if needed.
func NewStorage(dir string) (*Storage, error) {
	if dir == "" {
		return nil, errors.New("files: storage directory is empty")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("files: create storage directory: %w", err)
	}
	return &Storage{dir: dir}, nil
}

func (s *Storage) path(sum string) (string, error) {
	if !sumPattern.MatchString(sum) {
		return "", fmt.Errorf("files: invalid sha256 %q", sum)
	}
	return filepath.Join(s.dir, sum[0:2], sum[2:4], sum), nil
}

// Put stores data under its hash sum. Existing contents are kept (the same
// hash means the same bytes); new ones are written to a temporary file,
// synced, renamed (so a reader never sees a partial file) and the
// directories are synced, so the file survives a crash once Put returns.
func (s *Storage) Put(sum string, data []byte) error {
	p, err := s.path(sum)
	if err != nil {
		return err
	}
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".upload-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // no-op after the rename
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return err
	}
	// The rename and any new shard directories are durable only once their
	// parent directories are synced.
	shard := filepath.Dir(p)
	for _, dir := range []string{shard, filepath.Dir(shard), s.dir} {
		if err := syncDir(dir); err != nil {
			return err
		}
	}
	return nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir) //nolint:gosec // a directory of the storage
	if err != nil {
		return err
	}
	if err := d.Sync(); err != nil {
		_ = d.Close()
		return fmt.Errorf("files: sync %s: %w", dir, err)
	}
	return d.Close()
}

// Open opens the contents stored under sum; missing contents are an error
// wrapping fs.ErrNotExist.
func (s *Storage) Open(sum string) (*os.File, error) {
	p, err := s.path(sum)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p) //nolint:gosec // p is built from a validated hash
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("files: contents of %s missing on disk: %w", sum, err)
	}
	return f, err
}

// Remove deletes the contents stored under sum; missing contents are fine.
func (s *Storage) Remove(sum string) error {
	p, err := s.path(sum)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return syncDir(filepath.Dir(p))
}
