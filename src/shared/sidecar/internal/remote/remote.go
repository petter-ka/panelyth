// Package remote browses FTP and FTPS servers like folders (Stage C10.5,
// ADR-0037): connections, their folder listings as query-session sources,
// and the reads and writes that transfer jobs are built on. A server is
// untrusted input: its names are checked before they are listed, the host
// in a PASV reply is ignored, and a connection that asks for TLS never
// continues without it.
package remote

import (
	"context"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

// Kind is what a remote entry is.
type Kind uint8

const (
	KindFile Kind = iota
	KindDir
	// KindLink is a link on the server; it is listed and never followed.
	KindLink
)

// Entry is one entry of a remote folder.
type Entry struct {
	Name string
	Kind Kind
	Size int64
	// MtimeNs is the modification time in Unix nanoseconds; 0 = unknown.
	MtimeNs int64
}

// TLSMode says how a connection is encrypted.
type TLSMode string

const (
	// TLSNone is plain FTP: the password and the data cross the network in
	// the clear. It is only ever the user's explicit choice.
	TLSNone TLSMode = "none"
	// TLSExplicit upgrades the control connection with AUTH TLS (the default).
	TLSExplicit TLSMode = "explicit"
	// TLSImplicit speaks TLS from the first byte (port 990 by convention).
	TLSImplicit TLSMode = "implicit"
)

// Valid reports whether m is a known mode.
func (m TLSMode) Valid() bool { return m == TLSNone || m == TLSExplicit || m == TLSImplicit }

// Options describe a connection.
type Options struct {
	Host string
	Port int
	TLS  TLSMode
	// User is "" for an anonymous login.
	User     string
	Password string
	// Active makes the server connect back for data (PORT/EPRT); the default
	// is passive mode.
	Active bool
	// Encoding of names: "" or "utf-8", or the name of a single-byte code
	// page for servers that predate UTF-8 ("windows-1252", "ibm866", …).
	Encoding string
	// Fingerprint is the SHA-256 of a certificate the user accepted for this
	// connection (hex). With it, that certificate is trusted and no other.
	Fingerprint string
}

// Features are what a server said it supports (FEAT).
type Features struct {
	MLSD bool
	// Resume: REST STREAM, so a transfer cut off can go on where it stopped.
	Resume bool
	UTF8   bool
	MDTM   bool
	// TLS: the control and data connections are encrypted.
	TLS bool
}

// Client is one logged-in connection to a server. It runs one command at a
// time; the Manager serializes its callers. Paths are absolute, with "/"
// between their parts.
type Client interface {
	Features() Features
	// List reads a folder. Entries with unsafe names are left out and counted.
	List(ctx context.Context, dir string) (entries []Entry, rejected int, err error)
	// Retrieve copies a file to w, starting at offset (Features.Resume).
	Retrieve(ctx context.Context, path string, offset int64, w io.Writer) error
	// Store writes r to a file; at offset > 0 it continues a partial upload.
	Store(ctx context.Context, path string, offset int64, r io.Reader) error
	Mkdir(ctx context.Context, path string) error
	Rename(ctx context.Context, from, to string) error
	// Delete removes a file; Rmdir an empty folder.
	Delete(ctx context.Context, path string) error
	Rmdir(ctx context.Context, path string) error
	// Size asks for a file's size (after an upload that was cut off).
	Size(ctx context.Context, path string) (int64, error)
	// Noop keeps the control connection alive.
	Noop(ctx context.Context) error
	// Broken reports that the connection can no longer be used (a transfer
	// was cut in the middle of the protocol, the server went away).
	Broken() bool
	Close() error
}

// Errors of connecting and of commands. A *ServerError carries the
// server's own words.
var (
	// ErrAuth: the server refused the user name or the password.
	ErrAuth = errors.New("remote: login refused")
	// ErrTLSRequired: the connection asks for TLS and the server offers none.
	ErrTLSRequired = errors.New("remote: the server does not offer TLS")
	// ErrNotFound: no such file or folder on the server.
	ErrNotFound = errors.New("remote: not found")
	// ErrUnsafeName: a name that cannot be listed or sent.
	ErrUnsafeName = errors.New("remote: unsafe name")
	// ErrClosed: the connection was closed.
	ErrClosed = errors.New("remote: connection closed")
	// ErrUnsupported: the server lacks what the operation needs.
	ErrUnsupported = errors.New("remote: not supported by the server")
	// ErrTooLarge: a connection lists more entries than it may hold.
	ErrTooLarge = errors.New("remote: too many entries")
)

// CertificateError is a server certificate that does not verify. Fingerprint
// is its SHA-256 (hex), which the user may accept for the connection.
type CertificateError struct {
	Fingerprint string
	Subject     string
	// Changed: the connection had another certificate pinned.
	Changed bool
	Err     error
}

func (e *CertificateError) Error() string {
	return "remote: the server's certificate could not be verified: " + e.Err.Error()
}
func (e *CertificateError) Unwrap() error { return e.Err }

// ServerError is a negative reply of the server.
type ServerError struct {
	Code int
	Msg  string
}

func (e *ServerError) Error() string { return "remote: " + e.Msg }

// MaxNameBytes bounds a name the app lists or sends.
const MaxNameBytes = 1024

// SafeName reports whether a name from a server can be listed and sent back
// in a command: one path element, valid UTF-8, without a separator of
// either kind and without control characters (a line end would start
// another command). Whether it is also a valid name on this computer is
// checked where a download writes it.
func SafeName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > MaxNameBytes || !utf8.ValidString(name) {
		return false
	}
	for _, r := range name {
		if r == '/' || r == '\\' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// CleanDir normalizes an absolute folder path on a server: "/" between the
// parts, no "." or ".." parts, no trailing "/". It returns false for a path
// that is not absolute or has an unsafe part.
func CleanDir(p string) (string, bool) {
	if !strings.HasPrefix(p, "/") {
		return "", false
	}
	var parts []string
	for part := range strings.SplitSeq(p, "/") {
		if part == "" {
			continue
		}
		if !SafeName(part) {
			return "", false
		}
		parts = append(parts, part)
	}
	return "/" + strings.Join(parts, "/"), true
}

// Join adds a name to a folder path.
func Join(dir, name string) string {
	if dir == "/" {
		return "/" + name
	}
	return dir + "/" + name
}

// Base is the last part of a path ("/" for the root).
func Base(p string) string {
	if p == "/" {
		return "/"
	}
	return p[strings.LastIndex(p, "/")+1:]
}

// Parent is the folder holding a path ("/" for the root and for its children).
func Parent(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "/"
	}
	return p[:i]
}
