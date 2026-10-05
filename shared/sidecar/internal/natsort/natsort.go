// Package natsort builds precomputed natural-sort keys, so SQLite can order
// "IMG_2" before "IMG_10" with a plain BINARY index (ADR-0015, analysis M10).
package natsort

import (
	"strings"
	"unicode/utf8"
)

// Key returns a byte-comparable key: the lowercased name with every ASCII
// digit run replaced by a two-digit length followed by the digits without
// leading zeros. Shorter numbers therefore sort first, and equal-length
// numbers compare digit by digit. Names that differ only in leading zeros
// ("01" vs "1") get equal keys; callers tie-break on name and id.
func Key(name string) string {
	s := strings.ToLower(name)
	var b strings.Builder
	b.Grow(len(s) + 8)
	for i := 0; i < len(s); {
		c := s[i]
		if c < '0' || c > '9' {
			_, size := utf8.DecodeRuneInString(s[i:])
			b.WriteString(s[i : i+size])
			i += size
			continue
		}
		j := i
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		digits := strings.TrimLeft(s[i:j], "0")
		if digits == "" {
			digits = "0"
		}
		n := len(digits)
		if n > 99 {
			digits, n = digits[:99], 99
		}
		b.WriteByte(byte('0' + n/10))
		b.WriteByte(byte('0' + n%10))
		b.WriteString(digits)
		i = j
	}
	return b.String()
}
