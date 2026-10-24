package textedit

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"unicode/utf8"
)

// The page cuts the text into chunks by UTF-16 code units, so a chunk may
// end with the first half of a surrogate pair and the next begin with the
// second. JSON carries each half as a \u escape, which a JSON decoder turns
// into U+FFFD on its own. decodeChunk therefore takes the chunk as raw JSON,
// cuts such halves off its ends, and the session joins them across chunks.

var errNotString = errors.New("text must be a string")

// chunk is one decoded chunk of text.
type chunk struct {
	text string
	// lead is a low surrogate the chunk begins with, trail a high surrogate
	// it ends with (0 when there is none).
	lead, trail uint16
	// units is the chunk's length in UTF-16 code units.
	units int
}

func decodeChunk(raw []byte) (chunk, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return chunk{}, errNotString
	}
	var c chunk
	// A backslash right after the opening quote always starts an escape.
	if u, ok := escapedUnit(raw[1:]); ok && u >= 0xDC00 && u <= 0xDFFF {
		c.lead = u
		raw = append([]byte{'"'}, raw[7:]...)
	}
	// At the end the backslash must not itself be escaped: an odd run of
	// backslashes before the u.
	if n := len(raw); n >= 8 {
		if u, ok := escapedUnit(raw[n-7 : n-1]); ok && u >= 0xD800 && u <= 0xDBFF && oddBackslashes(raw[:n-6]) {
			c.trail = u
			raw = append(raw[:n-7:n-7], '"')
		}
	}
	if err := json.Unmarshal(raw, &c.text); err != nil {
		return chunk{}, errNotString
	}
	c.units = utf16Len(c.text)
	if c.lead != 0 {
		c.units++
	}
	if c.trail != 0 {
		c.units++
	}
	return c, nil
}

// escapedUnit reads a \uXXXX escape at the start of b.
func escapedUnit(b []byte) (uint16, bool) {
	if len(b) < 6 || b[0] != '\\' || b[1] != 'u' {
		return 0, false
	}
	v, err := strconv.ParseUint(string(b[2:6]), 16, 16)
	if err != nil {
		return 0, false
	}
	return uint16(v), true
}

// oddBackslashes reports whether b ends with an odd number of backslashes.
func oddBackslashes(b []byte) bool {
	n := 0
	for i := len(b) - 1; i >= 0 && b[i] == '\\'; i-- {
		n++
	}
	return n%2 == 1
}

// utf16Len is the length of s in UTF-16 code units.
func utf16Len(s string) int {
	n := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			n++
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
		i += size
	}
	return n
}
