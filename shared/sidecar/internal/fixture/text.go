package fixture

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"unicode/utf16"
)

// TextSpec describes the lister fixtures (Stage C05, docs/commander/TESTING.md:
// text-2g and encodings).
type TextSpec struct {
	// LogBytes > 0 writes big.log: numbered log lines up to at least this size.
	LogBytes int64
	// Encodings writes the encoding samples (UTF-8 with and without a BOM,
	// UTF-16 LE/BE, Windows-1252, binary, a long single line).
	Encodings bool
}

// LogLine is line n of big.log; tests compute offsets from it.
func LogLine(n int64) string {
	return fmt.Sprintf("%09d 2026-10-06T12:00:00Z INFO request path=/api/items/%d status=200 took=%dms\n", n, n%9973, n%997)
}

// EncodingSample is the text every encoding sample holds.
const EncodingSample = "Grüße aus Köln — naïve café\r\nzweite Zeile\r\nthird line\r\n"

// GenerateText writes the text fixtures under root; a marker makes repeated
// calls with the same spec a no-op (the 2 GB log is written once per machine).
func GenerateText(root string, spec TextSpec) error {
	marker := filepath.Join(root, ".panelyth-fixture")
	want := fmt.Sprintf("text %+v", spec)
	if b, err := os.ReadFile(marker); err == nil && string(b) == want {
		return nil
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if spec.LogBytes > 0 {
		if err := writeLog(filepath.Join(root, "big.log"), spec.LogBytes); err != nil {
			return err
		}
	}
	if spec.Encodings {
		if err := writeEncodings(root); err != nil {
			return err
		}
	}
	return os.WriteFile(marker, []byte(want), 0o644)
}

func writeLog(path string, size int64) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 4<<20)
	var written int64
	for n := int64(0); written < size; n++ {
		k, err := w.WriteString(LogLine(n))
		if err != nil {
			_ = f.Close()
			return err
		}
		written += int64(k)
	}
	if err := w.Flush(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func utf16Bytes(s string, bigEndian bool) []byte {
	units := utf16.Encode([]rune(s))
	out := make([]byte, 0, 2+2*len(units))
	if bigEndian {
		out = append(out, 0xfe, 0xff)
	} else {
		out = append(out, 0xff, 0xfe)
	}
	for _, u := range units {
		if bigEndian {
			out = append(out, byte(u>>8), byte(u))
		} else {
			out = append(out, byte(u), byte(u>>8))
		}
	}
	return out
}

// windows1252 encodes the sample's characters (all in Latin-1 except the dash).
func windows1252(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		switch {
		case r == '—':
			out = append(out, 0x97)
		case r < 0x100:
			out = append(out, byte(r))
		default:
			out = append(out, '?')
		}
	}
	return out
}

func writeEncodings(root string) error {
	binary := make([]byte, 4096)
	for i := range binary {
		binary[i] = byte(i * 37)
	}
	long := make([]byte, 0, 100_010)
	for len(long) < 100_000 {
		long = append(long, "0123456789"...)
	}
	long = append(long, "\nend\n"...)
	files := map[string][]byte{
		"utf8.txt":      []byte(EncodingSample),
		"utf8-bom.txt":  append([]byte{0xef, 0xbb, 0xbf}, EncodingSample...),
		"utf16le.txt":   utf16Bytes(EncodingSample, false),
		"utf16be.txt":   utf16Bytes(EncodingSample, true),
		"latin1.txt":    windows1252(EncodingSample),
		"binary.bin":    binary,
		"long-line.txt": long,
		"empty.txt":     {},
		"tool.cmd":      []byte("@echo panelyth-test\r\n"),
		"tool.sh":       []byte("#!/bin/sh\necho panelyth-test\n"),
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(root, name), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}
