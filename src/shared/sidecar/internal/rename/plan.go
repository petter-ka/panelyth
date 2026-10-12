// Package rename is the batch-rename engine (ADR-0021, Stage C09). Two
// syntaxes compile to one Plan: the viewer's "{name}{n:000}" pattern and the
// commander's Total Commander masks ("[N]", "[N2-5]", "[E]", "[C]", "[Y]"…)
// with search and replace and case conversion. Resolve names a whole batch
// and decides which renames are valid and free; the preview and the job use
// the same result.
package rename

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"panelyth/sidecar/internal/fileops"
)

// Limits of a plan.
const (
	// MaxMask bounds each mask and the search and replace texts (bytes).
	MaxMask = 255
	// MaxStart and MaxStep bound the counter; MaxDigits its padding.
	MaxStart  = 1_000_000_000
	MaxStep   = 1_000_000
	MaxDigits = 10
)

// ErrPlan is returned (wrapped, with the reason) for a plan that cannot be
// compiled. Field says which input is wrong.
var ErrPlan = errors.New("invalid rename plan")

// PlanError names the field of a Spec that cannot be used.
type PlanError struct {
	// Field is "nameMask", "extMask", "search", "case", "counter" or "pattern".
	Field  string
	Reason string
}

func (e *PlanError) Error() string { return e.Reason }
func (e *PlanError) Unwrap() error { return ErrPlan }

func planError(field, format string, args ...any) error {
	return &PlanError{Field: field, Reason: fmt.Sprintf(format, args...)}
}

// Case is a case conversion of the new name.
type Case string

const (
	CaseKeep  Case = ""
	CaseLower Case = "lower"
	CaseUpper Case = "upper"
	// CaseFirst and CaseWords change the name without its extension: the
	// first letter, or the first letter of every word, in upper case and
	// the rest in lower case.
	CaseFirst Case = "first"
	CaseWords Case = "words"
)

// Spec is a multi-rename as the commander's dialog describes it.
type Spec struct {
	// NameMask and ExtMask build the name and the extension. Placeholders:
	// [N] the name, [E] the extension, both with ranges ([N2-5], [N2-],
	// [N2,3], [N2]); [C] the counter, optionally [C<start>+<step>:<digits>];
	// [Y] [M] [D] [h] [m] [s] from the modification time (local time); [[]
	// and []] for brackets.
	NameMask string
	ExtMask  string
	// Search is replaced by Replace in the name the masks give (with its
	// extension). Regex: Go RE2 syntax, with $1 in Replace.
	Search    string
	Replace   string
	Regex     bool
	MatchCase bool
	Case      Case
	// The counter of [C]: first value, step and minimum digits.
	Start  int
	Step   int
	Digits int
}

type partKind uint8

const (
	partLiteral partKind = iota
	partName
	partExt
	partCounter
	partYear
	partMonth
	partDay
	partHour
	partMinute
	partSecond
)

type part struct {
	kind    partKind
	literal string
	// Range of [N] and [E] in characters from 1; to 0 = to the end.
	from, to int
	// Counter.
	start, step, digits int
}

// Plan is a compiled rename. The zero value is not usable.
type Plan struct {
	name, ext []part
	// trim removes spaces around the name (the viewer's pattern).
	trim    bool
	re      *regexp.Regexp
	replace string
	// literal: the replacement is plain text, not a template.
	literal bool
	kase    Case
	dated   bool
}

// Item is an entry to name.
type Item struct {
	Name  string
	IsDir bool
	// ModNs is the modification time, for the date placeholders.
	ModNs int64
}

// ParseViewer compiles the viewer's pattern (ADR-0021): literal text with
// {name} (the name without its extension) and {n} or {n:000} (a counter,
// padded to the width of the zeros). The extension is always kept. The
// pattern must contain a token, so a batch never maps every file to one
// name.
func ParseViewer(pattern string, start int) (*Plan, error) {
	if pattern == "" || len(pattern) > MaxMask {
		return nil, planError("pattern", "the pattern is empty or too long")
	}
	if start < 0 || start > MaxStart {
		return nil, planError("counter", "the start number is out of range")
	}
	p := &Plan{trim: true, ext: []part{{kind: partExt, from: 1}}}
	hasToken := false
	for s := pattern; len(s) > 0; {
		open := strings.IndexByte(s, '{')
		if open < 0 {
			p.name = append(p.name, part{literal: s})
			break
		}
		if open > 0 {
			p.name = append(p.name, part{literal: s[:open]})
		}
		end := strings.IndexByte(s[open:], '}')
		if end < 0 {
			return nil, planError("pattern", "a { has no }")
		}
		tok := s[open+1 : open+end]
		switch {
		case tok == "name":
			p.name = append(p.name, part{kind: partName, from: 1})
		case tok == "n":
			p.name = append(p.name, part{kind: partCounter, start: start, step: 1, digits: 1})
		case strings.HasPrefix(tok, "n:") && len(tok) > 2 && len(tok) <= 2+MaxDigits && strings.Trim(tok[2:], "0") == "":
			p.name = append(p.name, part{kind: partCounter, start: start, step: 1, digits: len(tok) - 2})
		default:
			return nil, planError("pattern", "unknown token {%s}", tok)
		}
		hasToken = true
		s = s[open+end+1:]
	}
	if !hasToken {
		return nil, planError("pattern", "the pattern needs {name} or {n}")
	}
	return p, nil
}

// Compile compiles the commander's masks, search and case conversion.
func Compile(s Spec) (*Plan, error) {
	if len(s.NameMask) > MaxMask || len(s.ExtMask) > MaxMask {
		return nil, planError("nameMask", "the mask is too long")
	}
	if len(s.Search) > MaxMask || len(s.Replace) > MaxMask {
		return nil, planError("search", "the search or replace text is too long")
	}
	if s.Start < -MaxStart || s.Start > MaxStart || s.Step < -MaxStep || s.Step > MaxStep ||
		s.Digits < 1 || s.Digits > MaxDigits {
		return nil, planError("counter", "the counter is out of range")
	}
	switch s.Case {
	case CaseKeep, CaseLower, CaseUpper, CaseFirst, CaseWords:
	default:
		return nil, planError("case", "unknown case conversion %q", string(s.Case))
	}
	p := &Plan{kase: s.Case}
	var err error
	if p.name, err = parseMask(s.NameMask, "nameMask", s); err != nil {
		return nil, err
	}
	if p.ext, err = parseMask(s.ExtMask, "extMask", s); err != nil {
		return nil, err
	}
	for _, pt := range append(append([]part{}, p.name...), p.ext...) {
		if pt.kind >= partYear {
			p.dated = true
		}
	}
	if s.Search != "" {
		expr := s.Search
		if !s.Regex {
			expr = regexp.QuoteMeta(expr)
			p.literal = true
		}
		if !s.MatchCase {
			expr = "(?i)" + expr
		}
		if p.re, err = regexp.Compile(expr); err != nil {
			return nil, planError("search", "%s", regexReason(err))
		}
		p.replace = s.Replace
	}
	return p, nil
}

// regexReason is the parser's reason without the expression it repeats.
func regexReason(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, ": "); i >= 0 && strings.HasPrefix(msg, "error parsing regexp") {
		msg = msg[i+2:]
	}
	return msg
}

// parseMask splits a mask into literals and placeholders.
func parseMask(mask, field string, s Spec) ([]part, error) {
	if !utf8.ValidString(mask) {
		return nil, planError(field, "the mask is not valid text")
	}
	var parts []part
	literal := func(text string) {
		if n := len(parts); n > 0 && parts[n-1].kind == partLiteral {
			parts[n-1].literal += text
			return
		}
		parts = append(parts, part{literal: text})
	}
	for rest := mask; len(rest) > 0; {
		open := strings.IndexByte(rest, '[')
		if open < 0 {
			literal(rest)
			break
		}
		if open > 0 {
			literal(rest[:open])
		}
		rest = rest[open:]
		// [[] and []] are the brackets themselves.
		if strings.HasPrefix(rest, "[[]") || strings.HasPrefix(rest, "[]]") {
			literal(rest[1:2])
			rest = rest[3:]
			continue
		}
		end := strings.IndexByte(rest, ']')
		if end < 0 {
			return nil, planError(field, "a [ has no ]")
		}
		pt, err := parsePlaceholder(rest[1:end], field, s)
		if err != nil {
			return nil, err
		}
		parts = append(parts, pt)
		rest = rest[end+1:]
	}
	return parts, nil
}

func parsePlaceholder(tok, field string, s Spec) (part, error) {
	if tok == "" {
		return part{}, planError(field, "[] is empty")
	}
	switch tok[0] {
	case 'N', 'E':
		kind := partName
		if tok[0] == 'E' {
			kind = partExt
		}
		from, to, ok := parseRange(tok[1:])
		if !ok {
			return part{}, planError(field, "[%s]: a range is [%c2-5], [%c2-], [%c2,3] or [%c2]", tok, tok[0], tok[0], tok[0], tok[0])
		}
		return part{kind: kind, from: from, to: to}, nil
	case 'C':
		pt := part{kind: partCounter, start: s.Start, step: s.Step, digits: s.Digits}
		if !parseCounter(tok[1:], &pt) {
			return part{}, planError(field, "[%s]: a counter is [C], [C10], [C10+2] or [C10+2:3]", tok)
		}
		return pt, nil
	}
	if len(tok) == 1 {
		switch tok[0] {
		case 'Y':
			return part{kind: partYear}, nil
		case 'M':
			return part{kind: partMonth}, nil
		case 'D':
			return part{kind: partDay}, nil
		case 'h':
			return part{kind: partHour}, nil
		case 'm':
			return part{kind: partMinute}, nil
		case 's':
			return part{kind: partSecond}, nil
		}
	}
	return part{}, planError(field, "unknown placeholder [%s]", tok)
}

// parseRange reads "", "2", "2-5", "2-" and "2,3" (three characters from the
// second) as a 1-based inclusive range; to 0 means to the end.
func parseRange(s string) (from, to int, ok bool) {
	if s == "" {
		return 1, 0, true
	}
	sep := strings.IndexAny(s, "-,")
	if sep < 0 {
		n, ok := position(s)
		return n, n, ok
	}
	from, ok = position(s[:sep])
	if !ok {
		return 0, 0, false
	}
	if s[sep+1:] == "" {
		return from, 0, s[sep] == '-'
	}
	n, ok := position(s[sep+1:])
	if !ok {
		return 0, 0, false
	}
	if s[sep] == ',' {
		return from, from + n - 1, true
	}
	return from, n, n >= from
}

func position(s string) (int, bool) {
	if s == "" || len(s) > 4 || strings.Trim(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n >= 1
}

// parseCounter reads "", "10", "10+2", "10+2:3", "+2" and ":3" into pt.
func parseCounter(s string, pt *part) bool {
	if i := strings.IndexByte(s, ':'); i >= 0 {
		n, err := strconv.Atoi(s[i+1:])
		if err != nil || n < 1 || n > MaxDigits {
			return false
		}
		pt.digits = n
		s = s[:i]
	}
	if i := strings.IndexByte(s, '+'); i >= 0 {
		n, err := strconv.Atoi(s[i+1:])
		if err != nil || n < -MaxStep || n > MaxStep {
			return false
		}
		pt.step = n
		s = s[:i]
	}
	if s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < -MaxStart || n > MaxStart {
			return false
		}
		pt.start = n
	}
	return true
}

// Name returns the new name of the item at position index of its batch.
func (p *Plan) Name(it Item, index int) string {
	stem, ext := fileops.SplitExt(it.Name, it.IsDir)
	ext = strings.TrimPrefix(ext, ".")
	var at time.Time
	if p.dated {
		at = time.Unix(0, it.ModNs)
	}
	var b strings.Builder
	p.build(&b, p.name, stem, ext, index, at)
	name := b.String()
	if p.trim {
		name = strings.TrimSpace(name)
	}
	b.Reset()
	p.build(&b, p.ext, stem, ext, index, at)
	if b.Len() > 0 {
		name += "." + b.String()
	}
	if p.re != nil {
		if p.literal {
			name = p.re.ReplaceAllLiteralString(name, p.replace)
		} else {
			name = p.re.ReplaceAllString(name, p.replace)
		}
	}
	return convertCase(name, it.IsDir, p.kase)
}

func (p *Plan) build(b *strings.Builder, parts []part, stem, ext string, index int, at time.Time) {
	for _, pt := range parts {
		switch pt.kind {
		case partLiteral:
			b.WriteString(pt.literal)
		case partName:
			b.WriteString(slice(stem, pt.from, pt.to))
		case partExt:
			b.WriteString(slice(ext, pt.from, pt.to))
		case partCounter:
			writePadded(b, pt.start+index*pt.step, pt.digits)
		case partYear:
			writePadded(b, at.Year(), 4)
		case partMonth:
			writePadded(b, int(at.Month()), 2)
		case partDay:
			writePadded(b, at.Day(), 2)
		case partHour:
			writePadded(b, at.Hour(), 2)
		case partMinute:
			writePadded(b, at.Minute(), 2)
		case partSecond:
			writePadded(b, at.Second(), 2)
		}
	}
}

func writePadded(b *strings.Builder, n, digits int) {
	if n < 0 {
		b.WriteByte('-')
		n = -n
	}
	num := strconv.Itoa(n)
	for i := len(num); i < digits; i++ {
		b.WriteByte('0')
	}
	b.WriteString(num)
}

// slice returns the characters from..to of s (from 1, inclusive; to 0 = the
// end). Positions beyond the text give what is there.
func slice(s string, from, to int) string {
	if from <= 1 && to == 0 {
		return s
	}
	start, end, n := len(s), len(s), 0
	for i := range s {
		n++
		if n == from {
			start = i
		}
		if to > 0 && n == to+1 {
			end = i
			break
		}
	}
	if start > end {
		return ""
	}
	return s[start:end]
}

func convertCase(name string, isDir bool, c Case) string {
	switch c {
	case CaseLower:
		return strings.ToLower(name)
	case CaseUpper:
		return strings.ToUpper(name)
	case CaseFirst, CaseWords:
		stem, ext := fileops.SplitExt(name, isDir)
		var b strings.Builder
		b.Grow(len(name))
		start := true
		for _, r := range stem {
			letter := unicode.IsLetter(r) || unicode.IsDigit(r)
			if letter && start {
				b.WriteRune(unicode.ToUpper(r))
			} else {
				b.WriteRune(unicode.ToLower(r))
			}
			switch {
			case letter:
				start = false
			case c == CaseWords && r != '\'':
				// An apostrophe stays inside its word ("don't" → "Don't").
				start = true
			}
		}
		return b.String() + ext
	}
	return name
}
