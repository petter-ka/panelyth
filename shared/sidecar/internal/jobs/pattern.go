package jobs

import (
	"errors"
	"strconv"
	"strings"

	"fastview/sidecar/internal/fileops"
)

// ErrPattern is returned for an unusable batch-rename pattern.
var ErrPattern = errors.New("invalid rename pattern")

// Pattern is a parsed batch-rename pattern (ADR-0021): literal text with
// {name} (original name without extension) and {n} / {n:000} (counter,
// zero-padded to the width of the zeros). The extension is always kept.
type Pattern struct {
	parts []part
}

type part struct {
	literal string
	token   byte // 0 literal, 'n' name, '#' counter
	width   int
}

// MaxPattern bounds the pattern length.
const MaxPattern = 255

// ParsePattern validates a pattern. It must contain {name} or {n}, so a
// batch never maps every file to one name.
func ParsePattern(s string) (Pattern, error) {
	if s == "" || len(s) > MaxPattern {
		return Pattern{}, ErrPattern
	}
	var p Pattern
	hasToken := false
	for len(s) > 0 {
		open := strings.IndexByte(s, '{')
		if open < 0 {
			p.parts = append(p.parts, part{literal: s})
			break
		}
		if open > 0 {
			p.parts = append(p.parts, part{literal: s[:open]})
		}
		end := strings.IndexByte(s[open:], '}')
		if end < 0 {
			return Pattern{}, ErrPattern
		}
		tok := s[open+1 : open+end]
		switch {
		case tok == "name":
			p.parts = append(p.parts, part{token: 'n'})
		case tok == "n":
			p.parts = append(p.parts, part{token: '#', width: 1})
		case strings.HasPrefix(tok, "n:") && len(tok) > 2 && len(tok) <= 12 && strings.Trim(tok[2:], "0") == "":
			p.parts = append(p.parts, part{token: '#', width: len(tok) - 2})
		default:
			return Pattern{}, ErrPattern
		}
		hasToken = true
		s = s[open+end+1:]
	}
	if !hasToken {
		return Pattern{}, ErrPattern
	}
	return p, nil
}

// Apply returns the new name for an item: the pattern with its tokens
// filled in, plus the original extension (none for folders).
func (p Pattern) Apply(original string, isDir bool, n int) string {
	stem, ext := fileops.SplitExt(original, isDir)
	var b strings.Builder
	for _, pt := range p.parts {
		switch pt.token {
		case 0:
			b.WriteString(pt.literal)
		case 'n':
			b.WriteString(stem)
		case '#':
			num := strconv.Itoa(n)
			if pad := pt.width - len(num); pad > 0 {
				b.WriteString(strings.Repeat("0", pad))
			}
			b.WriteString(num)
		}
	}
	return strings.TrimSpace(b.String()) + ext
}
