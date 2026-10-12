// Package textdiff compares two text files line by line (Stage C08). The
// files are never held in memory: a pass over each records where its lines
// start and a hash per line, the diff runs on the hashes, and the rows of
// the side-by-side view are read from the files page by page.
package textdiff

import (
	"bytes"
	"context"
	"errors"
	"hash/maphash"
	"io"
	"os"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
)

// MaxBytes is the largest file a text diff takes; larger files are compared
// by content only (identical or not).
const MaxBytes = 50 << 20

var (
	// ErrBinary is returned when a file is not text.
	ErrBinary = errors.New("textdiff: not a text file")
	// ErrTooLarge is returned for files beyond MaxBytes.
	ErrTooLarge = errors.New("textdiff: the file is too large for a text comparison")
	// ErrChanged is returned when a file changed after it was compared.
	ErrChanged = errors.New("textdiff: the file changed since it was compared")
)

// Encoding names how a file's text is stored.
type Encoding string

const (
	UTF8    Encoding = "utf-8"
	UTF16LE Encoding = "utf-16le"
	UTF16BE Encoding = "utf-16be"
	Latin   Encoding = "windows-1252"
)

// unit is the size of a code unit in bytes.
func (e Encoding) unit() int {
	if e == UTF16LE || e == UTF16BE {
		return 2
	}
	return 1
}

func (e Encoding) decoder() *encoding.Decoder {
	switch e {
	case UTF16LE:
		return unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder()
	case UTF16BE:
		return unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder()
	case Latin:
		return charmap.Windows1252.NewDecoder()
	}
	return nil
}

const detectBytes = 64 << 10

// detect reads the encoding from a file's first bytes: a byte order mark,
// else UTF-16 by where its zero bytes are, else UTF-8 when valid, else a
// single-byte code page. Zero bytes without a pattern, or many control
// characters, mean a binary file.
func detect(head []byte) (enc Encoding, mark int, ok bool) {
	switch {
	case bytes.HasPrefix(head, []byte{0xEF, 0xBB, 0xBF}):
		return UTF8, 3, true
	case bytes.HasPrefix(head, []byte{0xFF, 0xFE}):
		return UTF16LE, 2, true
	case bytes.HasPrefix(head, []byte{0xFE, 0xFF}):
		return UTF16BE, 2, true
	}
	var zeroEven, zeroOdd, control int
	for i, c := range head {
		switch {
		case c == 0 && i%2 == 0:
			zeroEven++
		case c == 0:
			zeroOdd++
		case c < 0x20 && c != '\t' && c != '\n' && c != '\r' && c != '\f' && c != 0x1b:
			control++
		}
	}
	if zeroEven+zeroOdd > 0 {
		pairs := len(head) / 2
		switch {
		case pairs > 0 && zeroOdd*10 >= pairs*4 && zeroEven*20 <= pairs:
			return UTF16LE, 0, true
		case pairs > 0 && zeroEven*10 >= pairs*4 && zeroOdd*20 <= pairs:
			return UTF16BE, 0, true
		}
		return "", 0, false
	}
	if control*10 > len(head) {
		return "", 0, false
	}
	// A multi-byte character may be cut at the end of the sample.
	valid := head
	for i := 0; i < utf8.UTFMax && len(valid) > 0 && !utf8.Valid(valid); i++ {
		valid = valid[:len(valid)-1]
	}
	if len(head)-len(valid) < utf8.UTFMax && utf8.Valid(valid) {
		return UTF8, 0, true
	}
	return Latin, 0, true
}

// file is one side after its pass.
type file struct {
	path    string
	size    int64
	mtimeNs int64
	enc     Encoding
	// starts[i] is the offset of line i; one more entry holds the size.
	starts []uint32
	// whole is the hash of every byte.
	whole uint64
}

func (f *file) lines() int { return len(f.starts) - 1 }

// probe stats a file and reads its encoding.
func probe(path string) (*file, int, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	if !fi.Mode().IsRegular() {
		return nil, 0, ErrBinary
	}
	if fi.Size() > MaxBytes {
		return nil, 0, ErrTooLarge
	}
	fh, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer fh.Close()
	head := make([]byte, detectBytes)
	n, err := io.ReadFull(fh, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, 0, err
	}
	enc, mark, ok := detect(head[:n])
	if !ok {
		return nil, 0, ErrBinary
	}
	return &file{path: path, size: fi.Size(), mtimeNs: fi.ModTime().UnixNano(), enc: enc}, mark, nil
}

// lineHasher hashes a line's text, without its line end, as it arrives in
// pieces. With decode set the text is hashed as UTF-8, so two files in
// different encodings compare by their text; otherwise the bytes are hashed
// as they are.
type lineHasher struct {
	h      maphash.Hash
	unit   int
	be     bool
	held   bool // a carriage return waits: it is dropped when the line ends
	decode *encoding.Decoder
	buf    []byte
}

func (l *lineHasher) isCR(p []byte) bool {
	if l.unit == 1 {
		return p[len(p)-1] == '\r'
	}
	if len(p) < 2 {
		return false
	}
	hi, lo := p[len(p)-1], p[len(p)-2]
	if l.be {
		hi, lo = lo, hi
	}
	return hi == 0 && lo == '\r'
}

func (l *lineHasher) put(p []byte) {
	if l.decode != nil {
		l.buf = append(l.buf, p...)
	} else {
		l.h.Write(p)
	}
}

func (l *lineHasher) write(p []byte) {
	if len(p) == 0 {
		return
	}
	if l.held {
		l.held = false
		if l.unit == 1 {
			l.put([]byte{'\r'})
		} else if l.be {
			l.put([]byte{0, '\r'})
		} else {
			l.put([]byte{'\r', 0})
		}
	}
	if l.isCR(p) {
		l.held = true
		p = p[:len(p)-l.unit]
	}
	l.put(p)
}

func (l *lineHasher) end() uint64 {
	l.held = false
	if l.decode != nil {
		if out, err := l.decode.Bytes(l.buf); err == nil {
			l.h.Write(out)
		} else {
			l.h.Write(l.buf)
		}
		l.buf = l.buf[:0]
	}
	sum := l.h.Sum64()
	l.h.Reset()
	return sum
}

const scanBuffer = 1 << 20

// scan passes over a file once: line starts, a hash per line, and the hash
// of the whole file.
func scan(ctx context.Context, f *file, mark int, seed maphash.Seed, decode bool) ([]uint64, error) {
	fh, err := os.Open(f.path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	lh := &lineHasher{unit: f.enc.unit(), be: f.enc == UTF16BE}
	lh.h.SetSeed(seed)
	if decode {
		lh.decode = f.enc.decoder()
	}
	var whole maphash.Hash
	whole.SetSeed(seed)

	var hashes []uint64
	f.starts = append(f.starts[:0], uint32(mark))
	buf := make([]byte, scanBuffer)
	var off int64
	open := false // the current line has bytes
	skip := mark
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, rerr := io.ReadFull(fh, buf)
		chunk := buf[:n]
		whole.Write(chunk)
		pos := min(skip, n)
		skip -= pos
		for pos < n {
			nl := -1
			if lh.unit == 1 {
				if i := bytes.IndexByte(chunk[pos:], '\n'); i >= 0 {
					nl = pos + i
				}
			} else {
				lo, hi := 0, 1
				if lh.be {
					lo, hi = 1, 0
				}
				// Units sit at even offsets (the mark has two bytes, the buffer an even size).
				for i := pos + (pos & 1); i+1 < n; i += 2 {
					if chunk[i+lo] == '\n' && chunk[i+hi] == 0 {
						nl = i
						break
					}
				}
			}
			if nl < 0 {
				lh.write(chunk[pos:])
				open = true
				pos = n
				break
			}
			lh.write(chunk[pos:nl])
			hashes = append(hashes, lh.end())
			pos = nl + lh.unit
			f.starts = append(f.starts, uint32(off+int64(pos)))
			open = false
		}
		off += int64(n)
		if errors.Is(rerr, io.EOF) || errors.Is(rerr, io.ErrUnexpectedEOF) {
			break
		}
		if rerr != nil {
			return nil, rerr
		}
	}
	if open {
		hashes = append(hashes, lh.end())
		f.starts = append(f.starts, uint32(off))
	}
	if off != f.size {
		return nil, ErrChanged
	}
	f.whole = whole.Sum64()
	return hashes, nil
}
