package find

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"slices"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// Encoding names match the lister's (Stage C05).
const (
	EncodingUTF8    = "utf-8"
	EncodingUTF16LE = "utf-16le"
	EncodingUTF16BE = "utf-16be"
)

// Encodings lists every supported encoding.
var Encodings = []string{EncodingUTF8, EncodingUTF16LE, EncodingUTF16BE,
	"windows-1252", "windows-1250", "windows-1251", "iso-8859-2", "koi8-r"}

// DefaultEncodings covers UTF-8, UTF-16 text from Windows tools and Western
// single-byte files.
var DefaultEncodings = []string{EncodingUTF8, EncodingUTF16LE, "windows-1252"}

var singleByte = map[string]*charmap.Charmap{
	"windows-1252": charmap.Windows1252,
	"windows-1250": charmap.Windows1250,
	"windows-1251": charmap.Windows1251,
	"iso-8859-2":   charmap.ISO8859_2,
	"koi8-r":       charmap.KOI8R,
}

// ChunkSize is the read size per file; each content worker holds one buffer.
const ChunkSize = 1 << 20

// ctxBytes is the context kept around a match for whole-word checks.
const ctxBytes = 4

// pattern is the text in one encoding: per character, the byte sequences of
// its case variants (all of the same length, so offsets are fixed).
type pattern struct {
	chars  [][][]byte
	length int
	unit   int // 2 for UTF-16: matches start at even offsets
	// anchor is the offset whose byte set is rarest; candidates are found
	// with bytes.IndexByte on its bytes.
	anchor      int
	anchorBytes []byte
	// decode reads the character before or after a match (whole words).
	before func(b []byte) rune
	after  func(b []byte) rune
}

type matcher struct {
	pats   []*pattern
	groups []*group
	whole  bool
	maxLen int
}

func newMatcher(text string, encs []string, caseSensitive, whole bool) (*matcher, error) {
	m := &matcher{whole: whole}
	seen := map[string]bool{}
	for _, enc := range encs {
		p := buildPattern([]rune(text), enc, caseSensitive)
		if p == nil {
			continue // the text has characters this encoding cannot hold
		}
		// UTF-8 and the single-byte encodings agree on ASCII text; a
		// whole-word check decodes neighbors per encoding, so only plain
		// searches share one pattern.
		key := patternKey(p)
		if !whole && seen[key] {
			continue
		}
		seen[key] = true
		m.pats = append(m.pats, p)
		m.maxLen = max(m.maxLen, p.length)
	}
	if len(m.pats) == 0 {
		return nil, errors.New("the text cannot be written in the chosen encodings")
	}
	m.groups = groupPatterns(m.pats)
	return m, nil
}

func patternKey(p *pattern) string {
	var b bytes.Buffer
	for _, alts := range p.chars {
		for _, a := range alts {
			b.Write(a)
			b.WriteByte(0xff)
		}
		b.WriteByte(0xfe)
	}
	return b.String()
}

// variants returns r and, unless caseSensitive, its case-fold orbit.
func variants(r rune, caseSensitive bool) []rune {
	out := []rune{r}
	if caseSensitive {
		return out
	}
	for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
		out = append(out, f)
	}
	return out
}

func buildPattern(text []rune, enc string, caseSensitive bool) *pattern {
	var encode func(r rune) ([]byte, bool)
	p := &pattern{unit: 1}
	switch enc {
	case EncodingUTF8:
		encode = func(r rune) ([]byte, bool) { return utf8.AppendRune(nil, r), r != utf8.RuneError }
		p.before = func(b []byte) rune { r, _ := utf8.DecodeLastRune(b); return r }
		p.after = func(b []byte) rune { r, _ := utf8.DecodeRune(b); return r }
	case EncodingUTF16LE, EncodingUTF16BE:
		le := enc == EncodingUTF16LE
		p.unit = 2
		encode = func(r rune) ([]byte, bool) {
			var out []byte
			for _, u := range utf16.Encode([]rune{r}) {
				if le {
					out = append(out, byte(u), byte(u>>8))
				} else {
					out = append(out, byte(u>>8), byte(u))
				}
			}
			return out, true
		}
		unit := func(b []byte) rune {
			if le {
				return rune(b[0]) | rune(b[1])<<8
			}
			return rune(b[0])<<8 | rune(b[1])
		}
		p.before = func(b []byte) rune {
			if len(b) < 2 {
				return utf8.RuneError
			}
			return unit(b[len(b)-2:])
		}
		p.after = func(b []byte) rune {
			if len(b) < 2 {
				return utf8.RuneError
			}
			return unit(b)
		}
	default:
		cm := singleByte[enc]
		encode = func(r rune) ([]byte, bool) {
			b, ok := cm.EncodeRune(r)
			return []byte{b}, ok
		}
		// A neighbor that is a valid UTF-8 sequence reads as one: the same
		// bytes are often searched as UTF-8 and single-byte text at once,
		// and "äcat" must not be a whole word in a UTF-8 file.
		p.before = func(b []byte) rune {
			if r, n := utf8.DecodeLastRune(b); n > 1 {
				return r
			}
			return cm.DecodeByte(b[len(b)-1])
		}
		p.after = func(b []byte) rune {
			if r, n := utf8.DecodeRune(b); n > 1 {
				return r
			}
			return cm.DecodeByte(b[0])
		}
	}
	for _, r := range text {
		base, ok := encode(r)
		if !ok {
			return nil
		}
		alts := [][]byte{base}
		for _, v := range variants(r, caseSensitive)[1:] {
			if b, ok := encode(v); ok && len(b) == len(base) && !slices.ContainsFunc(alts, func(a []byte) bool { return bytes.Equal(a, b) }) {
				alts = append(alts, b)
			}
		}
		p.chars = append(p.chars, alts)
		p.length += len(base)
	}
	p.pickAnchor()
	return p
}

// byteWeight approximates how often a byte occurs in text, logs and
// source code (per mille, rounded): the anchor is the offset whose byte set
// is rarest, so bytes.IndexByte skips the most. NUL is frequent in UTF-16.
var byteWeight = func() (w [256]int) {
	for i := range w {
		w[i] = 1
	}
	freq := map[byte]int{' ': 150, 0: 300, '\n': 20, '\r': 15, '\t': 10, 'e': 90, 't': 65, 'a': 60, 'o': 58, 'i': 55,
		'n': 55, 's': 50, 'r': 50, 'h': 35, 'l': 32, 'd': 30, 'c': 25, 'u': 22, 'm': 20, 'f': 18, 'p': 16, 'g': 15,
		'w': 14, 'y': 13, 'b': 11, 'v': 8, 'k': 6, 'x': 2, 'j': 1, 'q': 1, 'z': 1, ',': 10, '.': 10, '-': 8, ':': 6,
		'=': 5, '/': 5, '_': 5, '"': 5, '(': 4, ')': 4, ';': 3, '\'': 3}
	for c := byte('0'); c <= '9'; c++ {
		freq[c] = 10
	}
	for c := byte('a'); c <= 'z'; c++ {
		if f, ok := freq[c]; ok {
			freq[c-'a'+'A'] = max(1, f/8)
		}
	}
	for b, f := range freq {
		w[b] = f
	}
	return w
}()

// pickAnchor chooses the offset whose byte set is rarest (byteWeight).
func (p *pattern) pickAnchor() {
	best, bestScore := 0, -1
	off := 0
	for _, alts := range p.chars {
		for k := range alts[0] {
			var set []byte
			for _, a := range alts {
				if !slices.Contains(set, a[k]) {
					set = append(set, a[k])
				}
			}
			score := 0
			for _, b := range set {
				score += byteWeight[b] + 1 // each byte costs one more IndexByte pass
			}
			if bestScore < 0 || score < bestScore {
				best, bestScore, p.anchorBytes = off+k, score, set
			}
		}
		off += len(alts[0])
	}
	p.anchor = best
}

// group shares one candidate scan between the patterns whose anchors have
// the same bytes (UTF-8 and UTF-16 of ASCII text anchor on the same letter).
type group struct {
	anchorBytes          []byte
	pats                 []*pattern
	minAnchor, maxAnchor int
}

func groupPatterns(pats []*pattern) []*group {
	var out []*group
	for _, p := range pats {
		var g *group
		for _, h := range out {
			if bytes.Equal(h.anchorBytes, p.anchorBytes) {
				g = h
				break
			}
		}
		if g == nil {
			g = &group{anchorBytes: p.anchorBytes, minAnchor: p.anchor, maxAnchor: p.anchor}
			out = append(out, g)
		}
		g.pats = append(g.pats, p)
		g.minAnchor, g.maxAnchor = min(g.minAnchor, p.anchor), max(g.maxAnchor, p.anchor)
	}
	return out
}

// find reports a match starting in [from, limit) of data, whose first byte
// is at file offset base. eof means data ends the file.
func (g *group) find(data []byte, from, limit int, base int64, eof, whole bool) bool {
	lo := from + g.minAnchor
	hi := min(len(data), limit+g.maxAnchor)
	if lo >= hi {
		return false
	}
	var next [4]int
	var anyOf [256]bool
	many := len(g.anchorBytes) > len(next)
	if many {
		for _, b := range g.anchorBytes {
			anyOf[b] = true
		}
	} else {
		for j := range g.anchorBytes {
			next[j] = -1
		}
	}
	cur := lo
	for cur < hi {
		a := -1
		if many {
			for i := cur; i < hi; i++ {
				if anyOf[data[i]] {
					a = i
					break
				}
			}
		} else {
			for j, b := range g.anchorBytes {
				if next[j] != hi && next[j] < cur {
					if k := bytes.IndexByte(data[cur:hi], b); k >= 0 {
						next[j] = cur + k
					} else {
						next[j] = hi
					}
				}
				if next[j] < hi && (a < 0 || next[j] < a) {
					a = next[j]
				}
			}
		}
		if a < 0 {
			return false
		}
		cur = a + 1
		for _, p := range g.pats {
			start := a - p.anchor
			if start < from || start >= limit || start+p.length > len(data) ||
				(p.unit == 2 && (base+int64(start))%2 != 0) {
				continue
			}
			if !p.verify(data[start:]) {
				continue
			}
			if whole && !p.wordBounded(data, start, base, eof) {
				continue
			}
			return true
		}
	}
	return false
}

func (p *pattern) verify(b []byte) bool {
	off := 0
	for _, alts := range p.chars {
		n := len(alts[0])
		ok := false
		for _, a := range alts {
			if bytes.Equal(b[off:off+n], a) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
		off += n
	}
	return true
}

func (p *pattern) wordBounded(data []byte, start int, base int64, eof bool) bool {
	if start > 0 {
		if isWordRune(p.before(data[max(0, start-ctxBytes):start])) {
			return false
		}
	} else if base > 0 {
		return false // no context kept before this start: cannot happen with carry
	}
	end := start + p.length
	if end < len(data) {
		if isWordRune(p.after(data[end:min(len(data), end+ctxBytes)])) {
			return false
		}
	} else if !eof {
		return false
	}
	return true
}

// errBinary marks a file skipped as binary.
var errBinary = errors.New("find: binary file")

// searchFile reports whether the file at path contains the text. buf must
// hold ChunkSize bytes plus room for the carry; read counts bytes read.
func (m *matcher) searchFile(ctx context.Context, path string, buf []byte, skipBinary bool, read *int64) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	keep := m.maxLen + ctxBytes
	carry, from := 0, 0
	var base int64
	first := true
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		n, rerr := io.ReadFull(f, buf[carry:])
		*read += int64(n)
		eof := errors.Is(rerr, io.EOF) || errors.Is(rerr, io.ErrUnexpectedEOF)
		if rerr != nil && !eof {
			return false, rerr
		}
		data := buf[:carry+n]
		if first {
			first = false
			if skipBinary && looksBinary(data[:min(len(data), 8192)]) {
				return false, errBinary
			}
		}
		limit := len(data)
		if !eof {
			limit = len(data) - keep
		}
		for _, g := range m.groups {
			if g.find(data, from, limit, base, eof, m.whole) {
				return true, nil
			}
		}
		if eof {
			return false, nil
		}
		// Keep the undecided tail and some context before it.
		cs := max(0, limit-ctxBytes)
		carry = copy(buf, data[cs:])
		from = limit - cs
		base += int64(cs)
	}
}

// looksBinary: NUL bytes that are not the zero halves of UTF-16 text.
func looksBinary(b []byte) bool {
	if len(b) >= 2 && ((b[0] == 0xff && b[1] == 0xfe) || (b[0] == 0xfe && b[1] == 0xff)) {
		return false
	}
	var even, odd int
	for i, c := range b {
		if c == 0 {
			if i%2 == 0 {
				even++
			} else {
				odd++
			}
		}
	}
	nul := even + odd
	if nul == 0 {
		return false
	}
	// UTF-16 ASCII: about every other byte is NUL, all at one parity.
	half := len(b) / 2
	if half > 0 && (odd*10 >= half*3 && even*20 <= odd || even*10 >= half*3 && odd*20 <= even) {
		return false
	}
	return true
}
