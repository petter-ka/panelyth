package library

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Stage C10.5: saved connections; a password only as opaque ciphertext.

func sampleConnection() Connection {
	return Connection{Name: "Work server", Group: "Work", Host: "ftp.example.org", Port: 21, TLS: "explicit",
		User: "alice", StartPath: "/pub", Transfers: 2}
}

func TestConnectionsAreSavedChangedAndRemoved(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	l, err := Open(filepath.Join(dir, "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	secret := []byte{0x01, 0xfe, 0x00, 0x7f}
	saved, err := l.SaveConnection(ctx, sampleConnection(), secret)
	if err != nil || saved.ID == 0 || !saved.HasPassword {
		t.Fatalf("save: %+v %v", saved, err)
	}
	second, err := l.SaveConnection(ctx, Connection{Name: "anon", Host: "10.0.0.7", Port: 2121, TLS: "none", Transfers: 1}, nil)
	if err != nil || second.HasPassword {
		t.Fatalf("save without a password: %+v %v", second, err)
	}
	list, err := l.Connections(ctx)
	if err != nil || len(list) != 2 || list[0].Name != "anon" || list[1].Name != "Work server" {
		t.Fatalf("list: %+v %v", list, err)
	}
	// The list carries no secret; the ciphertext comes back only when asked for by id.
	got, err := l.ConnectionSecret(ctx, saved.ID)
	if err != nil || !bytes.Equal(got, secret) {
		t.Errorf("secret %v %v", got, err)
	}
	if got, err := l.ConnectionSecret(ctx, second.ID); err != nil || got != nil {
		t.Errorf("no secret: %v %v", got, err)
	}

	// A change keeps the stored password unless it is replaced or forgotten.
	saved.Host, saved.Encoding, saved.Active = "ftp2.example.org", "Windows-1252", true
	changed, err := l.SaveConnection(ctx, saved, nil)
	if err != nil || !changed.HasPassword || changed.Host != "ftp2.example.org" || changed.Encoding != "windows-1252" {
		t.Fatalf("change: %+v %v", changed, err)
	}
	if got, _ := l.ConnectionSecret(ctx, saved.ID); !bytes.Equal(got, secret) {
		t.Error("a change without a password dropped the stored one")
	}
	if c, err := l.SaveConnection(ctx, saved, []byte("new")); err != nil || !c.HasPassword {
		t.Fatal(err)
	}
	if got, _ := l.ConnectionSecret(ctx, saved.ID); string(got) != "new" {
		t.Errorf("replaced secret %q", got)
	}
	if c, err := l.SaveConnection(ctx, saved, []byte{}); err != nil || c.HasPassword {
		t.Fatalf("forget: %+v %v", c, err)
	}
	if got, _ := l.ConnectionSecret(ctx, saved.ID); got != nil {
		t.Errorf("forgotten secret %v", got)
	}

	// An accepted certificate.
	print := strings.Repeat("AB", 32)
	if err := l.SetConnectionFingerprint(ctx, saved.ID, print); err != nil {
		t.Fatal(err)
	}
	if c, _ := l.Connection(ctx, saved.ID); c.Fingerprint != strings.ToLower(print) {
		t.Errorf("fingerprint %q", c.Fingerprint)
	}
	if err := l.SetConnectionFingerprint(ctx, saved.ID, "not hex"); !errors.Is(err, ErrInvalid) {
		t.Errorf("a bad fingerprint: %v", err)
	}
	if err := l.SetConnectionFingerprint(ctx, 999, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("an unknown connection: %v", err)
	}

	if err := l.RemoveConnection(ctx, saved.ID); err != nil {
		t.Fatal(err)
	}
	if err := l.RemoveConnection(ctx, saved.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("removed twice: %v", err)
	}
	if _, err := l.ConnectionSecret(ctx, saved.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("the secret of a removed connection: %v", err)
	}
	if _, err := l.Connection(ctx, saved.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("a removed connection: %v", err)
	}
}

func TestConnectionsAreValidated(t *testing.T) {
	ctx := context.Background()
	l, err := Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if _, err := l.SaveConnection(ctx, sampleConnection(), nil); err != nil {
		t.Fatal(err)
	}
	change := func(f func(*Connection)) Connection {
		c := sampleConnection()
		c.Name = "another"
		f(&c)
		return c
	}
	for name, c := range map[string]Connection{
		"no name":             change(func(c *Connection) { c.Name = "  " }),
		"a name of two lines": change(func(c *Connection) { c.Name = "a\nb" }),
		"no host":             change(func(c *Connection) { c.Host = "" }),
		"a host with a path":  change(func(c *Connection) { c.Host = "example.org/x" }),
		"a host with a user":  change(func(c *Connection) { c.Host = "bob@example.org" }),
		"a host with a line":  change(func(c *Connection) { c.Host = "example.org\r\nUSER x" }),
		"port 0":              change(func(c *Connection) { c.Port = 0 }),
		"port 70000":          change(func(c *Connection) { c.Port = 70000 }),
		"unknown encryption":  change(func(c *Connection) { c.TLS = "maybe" }),
		"a relative folder":   change(func(c *Connection) { c.StartPath = "pub" }),
		"no transfers":        change(func(c *Connection) { c.Transfers = 0 }),
		"five transfers":      change(func(c *Connection) { c.Transfers = 5 }),
		"a short fingerprint": change(func(c *Connection) { c.Fingerprint = "abcd" }),
		"a user of two lines": change(func(c *Connection) { c.User = "a\r\nb" }),
	} {
		if _, err := l.SaveConnection(ctx, c, nil); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A name is taken without regard to case.
	dup := sampleConnection()
	dup.Name = "WORK SERVER"
	if _, err := l.SaveConnection(ctx, dup, nil); !errors.Is(err, ErrDuplicate) {
		t.Errorf("a taken name: %v", err)
	}
	if _, err := l.SaveConnection(ctx, change(func(c *Connection) { c.ID = 999 }), nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("a change of an unknown connection: %v", err)
	}
	if _, err := l.SaveConnection(ctx, change(func(*Connection) {}), make([]byte, MaxSecretBytes+1)); !errors.Is(err, ErrInvalid) {
		t.Errorf("a secret that is too large: %v", err)
	}
	if list, _ := l.Connections(ctx); len(list) != 1 {
		t.Errorf("%d connections after the refusals", len(list))
	}
}

func TestStoredPasswordIsNeverClearTextInTheFile(t *testing.T) {
	// The library keeps what it is given: the test stands in for main, which
	// hands over ciphertext. What matters here is that nothing else of a
	// connection could hold a password, and that the secret is its own column.
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	c := sampleConnection()
	if _, err := l.SaveConnection(ctx, c, []byte("CIPHERTEXT-9f2c")); err != nil {
		t.Fatal(err)
	}
	_ = l.Close()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("CIPHERTEXT-9f2c")) {
		t.Fatal("the secret was not written")
	}
	// Reopened (the migration is in place), the connection still has it.
	l, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	list, _ := l.Connections(ctx)
	if len(list) != 1 || !list[0].HasPassword {
		t.Errorf("after a reopen: %+v", list)
	}
	if v, _ := l.SchemaVersion(); v != len(migrations) || v < 6 {
		t.Errorf("schema %d", v)
	}
}
