// Package find searches folder trees by name, attributes, size, date and
// content (Stage C06). The walk is bounded, never follows links and stops on
// cancellation; only matches are written to the index, and a Source holds
// them in found order for query sessions (ADR-0017 as amended by C06).
package find

import (
	"errors"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/pathkey"
)

// Bounds keep a spec small and its matchers cheap.
const (
	MaxRoots    = 16
	MaxTextLen  = 1024 // characters
	MaxDepth    = 1024
	MaxMaskLen  = index.MaxMaskLen
	MaxPatterns = index.MaxMaskTerms
)

// ErrInvalid wraps spec validation errors.
var ErrInvalid = errors.New("find: invalid spec")

// Spec is one search, as the renderer sends it (validated by Compile).
type Spec struct {
	// Roots are absolute folders; duplicates and folders inside another root
	// are searched once.
	Roots []string
	// Mask is a name mask ("*.txt;*.md"), with exclusions after "|". An
	// exclusion ending in "\" or "/" names folders that are not entered.
	// Empty means every name.
	Mask string
	// Depth bounds the subfolder levels: 0 searches only the roots' own
	// entries; negative is unlimited.
	Depth int
	// Hidden includes hidden and system entries, and enters such folders.
	Hidden bool
	// Text, when set, keeps only files containing it.
	Text          string
	CaseSensitive bool
	WholeWords    bool
	// Encodings the text is searched in (Encoding* names); empty means
	// DefaultEncodings.
	Encodings []string
	// SkipBinary leaves out files that look binary in their first bytes.
	SkipBinary bool
	// Size bounds in bytes; negative means no bound. Size bounds and text
	// leave folders out of the results.
	MinSize, MaxSize int64
	// Modified bounds as Unix milliseconds; 0 means no bound.
	ModifiedAfter, ModifiedBefore int64
	// AttrsSet must all be set, AttrsClear must all be clear (fsx.Attr*).
	AttrsSet, AttrsClear int
}

// Compiled is a validated spec ready for Run.
type Compiled struct {
	Spec
	roots      []string
	include    [][]rune
	exclude    [][]rune
	excludeDir [][]rune
	content    *matcher
	folders    bool
}

// Compile validates s and prepares its matchers.
func Compile(s Spec) (*Compiled, error) {
	bad := func(msg string) (*Compiled, error) { return nil, errors.Join(ErrInvalid, errors.New(msg)) }
	if len(s.Roots) == 0 || len(s.Roots) > MaxRoots {
		return bad("give 1 to 16 folders to search in")
	}
	if len(s.Mask) > MaxMaskLen {
		return bad("the name mask is too long")
	}
	if !utf8.ValidString(s.Mask) || !utf8.ValidString(s.Text) {
		return bad("the mask and the text must be valid text")
	}
	if utf8.RuneCountInString(s.Text) > MaxTextLen {
		return bad("the text is too long")
	}
	if s.Depth > MaxDepth {
		s.Depth = MaxDepth
	}
	if s.MinSize >= 0 && s.MaxSize >= 0 && s.MaxSize < s.MinSize {
		return bad("the largest size is below the smallest")
	}
	if s.ModifiedAfter > 0 && s.ModifiedBefore > 0 && s.ModifiedBefore < s.ModifiedAfter {
		return bad("the date range ends before it starts")
	}
	if s.AttrsSet&s.AttrsClear != 0 {
		return bad("an attribute cannot be both required and excluded")
	}
	const attrBits = fsx.AttrHidden | fsx.AttrSystem | fsx.AttrReadOnly | fsx.AttrArchive | fsx.AttrExecutable
	if (s.AttrsSet|s.AttrsClear)&^attrBits != 0 {
		return bad("unknown attribute")
	}
	c := &Compiled{Spec: s}
	for _, r := range s.Roots {
		clean, err := pathkey.Clean(r)
		if err != nil {
			return bad("folders to search in must be absolute paths")
		}
		c.roots = append(c.roots, clean)
	}
	c.roots = dedupeRoots(c.roots)

	m := index.ParseMask(s.Mask)
	lit := func(p string) []rune { return []rune(strings.ReplaceAll(p, "[[]", "[")) }
	for _, p := range m.Include {
		c.include = append(c.include, lit(p))
	}
	for _, p := range m.Exclude {
		if strings.HasSuffix(p, `\`) || strings.HasSuffix(p, "/") {
			if d := strings.TrimRight(p, `\/`); d != "" {
				c.excludeDir = append(c.excludeDir, lit(d))
			}
			continue
		}
		c.exclude = append(c.exclude, lit(p))
	}
	if s.Text != "" {
		encs := s.Encodings
		if len(encs) == 0 {
			encs = DefaultEncodings
		}
		for _, e := range encs {
			if !slices.Contains(Encodings, e) {
				return bad("unknown encoding " + e)
			}
		}
		mt, err := newMatcher(s.Text, encs, s.CaseSensitive, s.WholeWords)
		if err != nil {
			return bad(err.Error())
		}
		c.content = mt
	}
	c.folders = s.Text == "" && s.MinSize < 0 && s.MaxSize < 0
	return c, nil
}

// Roots returns the cleaned, deduplicated roots.
func (c *Compiled) Roots() []string { return c.roots }

// dedupeRoots drops repeated roots and roots inside another root.
func dedupeRoots(roots []string) []string {
	keys := make([]string, len(roots))
	for i, r := range roots {
		keys[i] = pathkey.DirKey(r)
	}
	var out []string
	for i, r := range roots {
		inside := false
		for j, k := range keys {
			if j == i {
				continue
			}
			if (k == keys[i] && j < i) || (k != keys[i] && strings.HasPrefix(keys[i], k)) {
				inside = true
				break
			}
		}
		if !inside {
			out = append(out, r)
		}
	}
	return out
}

// matchName applies the include and exclude masks to a folded name.
func (c *Compiled) matchName(fold []rune) bool {
	if len(c.include) > 0 {
		ok := false
		for _, p := range c.include {
			if glob(p, fold) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	for _, p := range c.exclude {
		if glob(p, fold) {
			return false
		}
	}
	return true
}

// skipDir reports whether a folder is excluded from the walk.
func (c *Compiled) skipDir(fold []rune) bool {
	for _, p := range c.excludeDir {
		if glob(p, fold) {
			return true
		}
	}
	return false
}

// matchMeta applies the attribute, size and date bounds.
func (c *Compiled) matchMeta(isDir bool, size, mtimeNs int64, attrs int) bool {
	if attrs&c.AttrsSet != c.AttrsSet || attrs&c.AttrsClear != 0 {
		return false
	}
	if !isDir {
		if c.MinSize >= 0 && size < c.MinSize {
			return false
		}
		if c.MaxSize >= 0 && size > c.MaxSize {
			return false
		}
	}
	ms := mtimeNs / 1e6
	if c.ModifiedAfter > 0 && ms < c.ModifiedAfter {
		return false
	}
	if c.ModifiedBefore > 0 && ms > c.ModifiedBefore {
		return false
	}
	return true
}

// glob matches "*" (any run) and "?" (one character); the rest is literal.
func glob(p, n []rune) bool {
	pi, ni, star, mark := 0, 0, -1, 0
	for ni < len(n) {
		switch {
		case pi < len(p) && (p[pi] == '?' || p[pi] == n[ni]):
			pi++
			ni++
		case pi < len(p) && p[pi] == '*':
			star, mark = pi, ni
			pi++
		case star >= 0:
			pi = star + 1
			mark++
			ni = mark
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

// foldRunes is the folded name as runes, reusing buf.
func foldRunes(name string, buf []rune) []rune {
	buf = buf[:0]
	for _, r := range index.FoldName(name) {
		buf = append(buf, r)
	}
	return buf
}

func isWordRune(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) }
