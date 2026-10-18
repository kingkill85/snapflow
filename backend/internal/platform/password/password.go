// Package password hashes and verifies passwords with argon2id.
package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// MinLength is the minimum password length, everywhere.
const MinLength = 8

// Parameters follow the OWASP recommendation for argon2id.
const (
	memory  = 19 * 1024 // KiB
	time    = 2
	threads = 1
	keyLen  = 32
	saltLen = 16
)

var b64 = base64.RawStdEncoding

// Hash returns an encoded hash in the PHC string format.
func Hash(pw string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, time, memory, threads, keyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, memory, time, threads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// Verify reports whether pw matches the encoded hash.
func Verify(pw, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("password: unsupported hash format")
	}
	var version int
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errors.New("password: unsupported argon2 version")
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, fmt.Errorf("password: parameters: %w", err)
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("password: salt: %w", err)
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("password: key: %w", err)
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
