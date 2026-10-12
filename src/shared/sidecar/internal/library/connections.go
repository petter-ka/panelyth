package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Saved connections of the commander (Stage C10.5, ADR-0037): where a
// server is and how to reach it. A password is kept only as the ciphertext
// Electron main made with the system's secret store; this package never
// sees a password and treats the ciphertext as opaque bytes.
const (
	MaxConnections     = 200
	MaxConnectionName  = 128
	MaxConnectionField = 4096
	MaxSecretBytes     = 8192
)

// Connection is one saved connection. It carries no secret: HasPassword
// says whether one is stored.
type Connection struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Group string `json:"group"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
	// TLS is "explicit", "implicit" or "none".
	TLS string `json:"tls"`
	// User is "" for an anonymous login.
	User string `json:"user"`
	// StartPath is the folder on the server to open first ("" = "/").
	StartPath string `json:"startPath"`
	// LocalPath is a folder for the other panel ("" = leave it).
	LocalPath string `json:"localPath"`
	// Active: the server connects back for data instead of passive mode.
	Active bool `json:"active"`
	// Encoding of names: "" = UTF-8, else a code page's name.
	Encoding string `json:"encoding"`
	// Transfers that may run at once, 1..4.
	Transfers int `json:"transfers"`
	// Fingerprint is the certificate the user accepted (SHA-256, hex), or "".
	Fingerprint string `json:"fingerprint"`
	HasPassword bool   `json:"hasPassword"`
}

func oneLine(s string, maxRunes int) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > maxRunes {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func isHex(s string) bool {
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

// cleanConnection validates a connection and normalizes its text fields.
func cleanConnection(c Connection) (Connection, error) {
	c.Name, c.Group, c.Host = strings.TrimSpace(c.Name), strings.TrimSpace(c.Group), strings.TrimSpace(c.Host)
	c.User, c.Encoding = strings.TrimSpace(c.User), strings.ToLower(strings.TrimSpace(c.Encoding))
	c.Fingerprint = strings.ToLower(strings.TrimSpace(c.Fingerprint))
	bad := func(what string) (Connection, error) {
		return Connection{}, fmt.Errorf("%w: %s", ErrInvalid, what)
	}
	switch {
	case c.Name == "" || !oneLine(c.Name, MaxConnectionName):
		return bad("a connection needs a name of one line")
	case !oneLine(c.Group, MaxConnectionName):
		return bad("the group is one line of text")
	case c.Host == "" || len(c.Host) > 253 || !oneLine(c.Host, 253) || strings.ContainsAny(c.Host, " /\\@"):
		return bad("the host is a name or an address")
	case c.Port < 1 || c.Port > 65535:
		return bad("the port is 1..65535")
	case c.TLS != "explicit" && c.TLS != "implicit" && c.TLS != "none":
		return bad("unknown encryption")
	case !oneLine(c.User, MaxConnectionName):
		return bad("the user name is one line of text")
	case !oneLine(c.StartPath, MaxConnectionField) || !oneLine(c.LocalPath, MaxConnectionField):
		return bad("a folder is one line of text")
	case c.StartPath != "" && !strings.HasPrefix(c.StartPath, "/"):
		return bad("the folder on the server starts with /")
	case !oneLine(c.Encoding, 32):
		return bad("unknown encoding")
	case c.Transfers < 1 || c.Transfers > 4:
		return bad("1..4 transfers at once")
	case c.Fingerprint != "" && (len(c.Fingerprint) != 64 || !isHex(c.Fingerprint)):
		return bad("a certificate fingerprint is 64 hex digits")
	}
	return c, nil
}

const connectionColumns = `id, name, group_name, host, port, tls, user, start_path, local_path,
	active, encoding, transfers, fingerprint, secret IS NOT NULL`

func scanConnection(row interface{ Scan(...any) error }) (Connection, error) {
	var c Connection
	err := row.Scan(&c.ID, &c.Name, &c.Group, &c.Host, &c.Port, &c.TLS, &c.User, &c.StartPath, &c.LocalPath,
		&c.Active, &c.Encoding, &c.Transfers, &c.Fingerprint, &c.HasPassword)
	return c, err
}

// Connections lists the saved connections by group and name.
func (l *Library) Connections(ctx context.Context) ([]Connection, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT `+connectionColumns+` FROM connections ORDER BY group_fold, name_fold, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Connection{}
	for rows.Next() {
		c, err := scanConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Connection returns one saved connection.
func (l *Library) Connection(ctx context.Context, id int64) (Connection, error) {
	c, err := scanConnection(l.db.QueryRowContext(ctx, `SELECT `+connectionColumns+` FROM connections WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Connection{}, ErrNotFound
	}
	return c, err
}

// SaveConnection adds a connection (ID 0) or changes one. secret is the
// password's ciphertext: nil leaves what is stored, an empty slice forgets
// it, anything else replaces it. A name is unique without regard to case.
func (l *Library) SaveConnection(ctx context.Context, c Connection, secret []byte) (Connection, error) {
	c, err := cleanConnection(c)
	if err != nil {
		return Connection{}, err
	}
	if len(secret) > MaxSecretBytes {
		return Connection{}, fmt.Errorf("%w: the stored password is too large", ErrInvalid)
	}
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return Connection{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var other int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM connections WHERE name_fold = ? AND id <> ?`, strings.ToLower(c.Name), c.ID).Scan(&other)
	if err == nil {
		return Connection{}, ErrDuplicate
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Connection{}, err
	}
	now := time.Now().UnixMilli()
	if c.ID == 0 {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM connections`).Scan(&n); err != nil {
			return Connection{}, err
		}
		if n >= MaxConnections {
			return Connection{}, ErrTooManyItems
		}
		var stored any
		if len(secret) > 0 {
			stored = secret
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO connections
			(name, name_fold, group_name, group_fold, host, port, tls, user, start_path, local_path, active,
			 encoding, transfers, fingerprint, secret, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			c.Name, strings.ToLower(c.Name), c.Group, strings.ToLower(c.Group), c.Host, c.Port, c.TLS, c.User,
			c.StartPath, c.LocalPath, c.Active, c.Encoding, c.Transfers, c.Fingerprint, stored, now, now)
		if err != nil {
			return Connection{}, err
		}
		if c.ID, err = res.LastInsertId(); err != nil {
			return Connection{}, err
		}
	} else {
		res, err := tx.ExecContext(ctx, `UPDATE connections SET name = ?, name_fold = ?, group_name = ?, group_fold = ?,
			host = ?, port = ?, tls = ?, user = ?, start_path = ?, local_path = ?, active = ?, encoding = ?,
			transfers = ?, fingerprint = ?, updated_at = ? WHERE id = ?`,
			c.Name, strings.ToLower(c.Name), c.Group, strings.ToLower(c.Group), c.Host, c.Port, c.TLS, c.User,
			c.StartPath, c.LocalPath, c.Active, c.Encoding, c.Transfers, c.Fingerprint, now, c.ID)
		if err != nil {
			return Connection{}, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return Connection{}, ErrNotFound
		}
		switch {
		case secret == nil:
		case len(secret) == 0:
			_, err = tx.ExecContext(ctx, `UPDATE connections SET secret = NULL WHERE id = ?`, c.ID)
		default:
			_, err = tx.ExecContext(ctx, `UPDATE connections SET secret = ? WHERE id = ?`, secret, c.ID)
		}
		if err != nil {
			return Connection{}, err
		}
	}
	if err := tx.QueryRowContext(ctx, `SELECT secret IS NOT NULL FROM connections WHERE id = ?`, c.ID).Scan(&c.HasPassword); err != nil {
		return Connection{}, err
	}
	return c, tx.Commit()
}

// RemoveConnection forgets a connection and its stored password.
func (l *Library) RemoveConnection(ctx context.Context, id int64) error {
	res, err := l.db.ExecContext(ctx, `DELETE FROM connections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ConnectionSecret returns the stored password's ciphertext (nil = none).
// Only Electron main asks for it, to decrypt it for one connect.
func (l *Library) ConnectionSecret(ctx context.Context, id int64) ([]byte, error) {
	var secret []byte
	err := l.db.QueryRowContext(ctx, `SELECT secret FROM connections WHERE id = ?`, id).Scan(&secret)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return secret, err
}

// SetConnectionFingerprint records the certificate the user accepted for a
// connection ("" forgets it).
func (l *Library) SetConnectionFingerprint(ctx context.Context, id int64, fingerprint string) error {
	fingerprint = strings.ToLower(strings.TrimSpace(fingerprint))
	if fingerprint != "" && (len(fingerprint) != 64 || !isHex(fingerprint)) {
		return fmt.Errorf("%w: a certificate fingerprint is 64 hex digits", ErrInvalid)
	}
	res, err := l.db.ExecContext(ctx, `UPDATE connections SET fingerprint = ?, updated_at = ? WHERE id = ?`,
		fingerprint, time.Now().UnixMilli(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
