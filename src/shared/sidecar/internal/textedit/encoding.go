package textedit

import (
	"bytes"
	"encoding/binary"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// Encoding names are the contract's TEXT_ENCODINGS (the lister's names).
const (
	UTF8        = "utf-8"
	UTF16LE     = "utf-16le"
	UTF16BE     = "utf-16be"
	Windows1252 = "windows-1252"
)

// singleByte are the code pages a save can write. Detection yields
// windows-1252 only; the others are there for a file whose encoding the
// user names (they all keep ASCII as it is).
var singleByte = map[string]*charmap.Charmap{
	"windows-1252": charmap.Windows1252,
	"windows-1250": charmap.Windows1250,
	"windows-1251": charmap.Windows1251,
	"iso-8859-2":   charmap.ISO8859_2,
	"koi8-r":       charmap.KOI8R,
}

// Encodings lists every encoding a save can write.
var Encodings = []string{UTF8, UTF16LE, UTF16BE, "windows-1252", "windows-1250", "windows-1251", "iso-8859-2", "koi8-r"}

// Line endings are the contract's LINE_ENDINGS.
const (
	LF   = "lf"
	CRLF = "crlf"
	CR   = "cr"
)

func eolOf(le string) string {
	switch le {
	case CRLF:
		return "\r\n"
	case CR:
		return "\r"
	}
	return "\n"
}

var (
	bomUTF8    = []byte{0xEF, 0xBB, 0xBF}
	bomUTF16LE = []byte{0xFF, 0xFE}
	bomUTF16BE = []byte{0xFE, 0xFF}
)

// sniffBytes is how much of a file decides whether it is text (the stage's
// "NUL bytes in the first 8 KiB") and whether it is UTF-16 without a mark.
const sniffBytes = 8 << 10

// detect reads a whole file's encoding: a byte order mark first, else UTF-16
// by where the zero bytes are, else UTF-8 when the whole file is valid
// UTF-8, else windows-1252. Zero bytes without a pattern, or many control
// characters, mean a binary file (ok false). Only encodings the file
// decodes in losslessly are reported, so an unchanged text saves back byte
// for byte: UTF-16 must have an even length and paired surrogates (else it
// is not text), and a UTF-8 mark before invalid UTF-8 is read as three
// windows-1252 characters.
func detect(data []byte) (enc string, bom int, ok bool) {
	switch {
	case bytes.HasPrefix(data, bomUTF8):
		if utf8.Valid(data[3:]) {
			return UTF8, 3, true
		}
	case bytes.HasPrefix(data, bomUTF16LE):
		if validUTF16(data[2:], binary.LittleEndian) {
			return UTF16LE, 2, true
		}
		return "", 0, false
	case bytes.HasPrefix(data, bomUTF16BE):
		if validUTF16(data[2:], binary.BigEndian) {
			return UTF16BE, 2, true
		}
		return "", 0, false
	}
	head := data[:min(len(data), sniffBytes)]
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
		case pairs > 0 && zeroOdd*10 >= pairs*4 && zeroEven*20 <= pairs && validUTF16(data, binary.LittleEndian):
			return UTF16LE, 0, true
		case pairs > 0 && zeroEven*10 >= pairs*4 && zeroOdd*20 <= pairs && validUTF16(data, binary.BigEndian):
			return UTF16BE, 0, true
		}
		return "", 0, false
	}
	if control*10 > len(head) {
		return "", 0, false
	}
	if utf8.Valid(data) {
		return UTF8, 0, true
	}
	// Every byte has a character in windows-1252 as WHATWG (the page's
	// TextDecoder) reads it, the five undefined ones as C1 controls, so
	// this always round trips (see encodeSingle).
	return Windows1252, 0, true
}

// validUTF16 reports whether b is whole code units with every surrogate paired.
func validUTF16(b []byte, order binary.ByteOrder) bool {
	if len(b)%2 != 0 {
		return false
	}
	for i := 0; i < len(b); i += 2 {
		u := order.Uint16(b[i:])
		switch {
		case u < 0xD800 || u > 0xDFFF:
		case u <= 0xDBFF && i+3 < len(b):
			if lo := order.Uint16(b[i+2:]); lo >= 0xDC00 && lo <= 0xDFFF {
				i += 2
				continue
			}
			return false
		default:
			return false
		}
	}
	return true
}

// lineEnding counts LF, CRLF and lone CR in the text after its mark and
// returns the most common (LF when there are none; ties go to LF, then
// CRLF). CR and LF are one byte in UTF-8 and the code pages and never part
// of another character; UTF-16 is counted by code unit.
func lineEnding(body []byte, enc string) string {
	var lf, crlf, cr int
	switch enc {
	case UTF16LE, UTF16BE:
		var order binary.ByteOrder = binary.LittleEndian
		if enc == UTF16BE {
			order = binary.BigEndian
		}
		prevCR := false
		for i := 0; i+1 < len(body); i += 2 {
			switch order.Uint16(body[i:]) {
			case '\n':
				if prevCR {
					crlf++
					cr--
				} else {
					lf++
				}
				prevCR = false
			case '\r':
				cr++
				prevCR = true
			default:
				prevCR = false
			}
		}
	default:
		crlf = bytes.Count(body, []byte("\r\n"))
		lf = bytes.Count(body, []byte("\n")) - crlf
		cr = bytes.Count(body, []byte("\r")) - crlf
	}
	switch {
	case lf == 0 && crlf == 0 && cr == 0:
		return LF
	case lf >= crlf && lf >= cr:
		return LF
	case crlf >= cr:
		return CRLF
	}
	return CR
}

// encode writes text (lines separated by "\n", as the editor keeps them) in
// enc with the line ending le, after the byte order mark when bom is set.
// A character enc cannot represent stops it: ok false and the 1-based line
// of that character; nothing is replaced.
func encode(text, enc string, bom bool, le string) (out []byte, badLine int, ok bool) {
	eol := eolOf(le)
	switch enc {
	case UTF8:
		return encodeUTF8(text, bom, eol), 0, true
	case UTF16LE:
		return encodeUTF16(text, bom, eol, binary.LittleEndian, bomUTF16LE), 0, true
	case UTF16BE:
		return encodeUTF16(text, bom, eol, binary.BigEndian, bomUTF16BE), 0, true
	}
	cm := singleByte[enc]
	if cm == nil {
		return nil, 0, false
	}
	return encodeSingle(text, cm, eol)
}

func encodeUTF8(text string, bom bool, eol string) []byte {
	n := len(text)
	if eol != "\n" {
		n += strings.Count(text, "\n") * (len(eol) - 1)
	}
	if bom {
		n += 3
	}
	out := make([]byte, 0, n)
	if bom {
		out = append(out, bomUTF8...)
	}
	if eol == "\n" {
		return append(out, text...)
	}
	return appendLines(out, text, eol)
}

// appendLines appends text with each "\n" written as eol.
func appendLines(out []byte, text, eol string) []byte {
	for {
		i := strings.IndexByte(text, '\n')
		if i < 0 {
			return append(out, text...)
		}
		out = append(out, text[:i]...)
		out = append(out, eol...)
		text = text[i+1:]
	}
}

func encodeUTF16(text string, bom bool, eol string, order binary.AppendByteOrder, mark []byte) []byte {
	out := make([]byte, 0, 2*len(text)+2*len(eol)*strings.Count(text, "\n")+len(mark))
	if bom {
		out = append(out, mark...)
	}
	for _, r := range text {
		switch {
		case r == '\n':
			for i := 0; i < len(eol); i++ {
				out = order.AppendUint16(out, uint16(eol[i]))
			}
		case r < 0x10000:
			out = order.AppendUint16(out, uint16(r))
		default:
			hi, lo := utf16.EncodeRune(r)
			out = order.AppendUint16(out, uint16(hi))
			out = order.AppendUint16(out, uint16(lo))
		}
	}
	return out
}

func encodeSingle(text string, cm *charmap.Charmap, eol string) ([]byte, int, bool) {
	out := make([]byte, 0, len(text)+(len(eol)-1)*strings.Count(text, "\n"))
	line := 1
	for i := 0; i < len(text); {
		c := text[i]
		if c < utf8.RuneSelf {
			if c == '\n' {
				out = append(out, eol...)
				line++
			} else {
				out = append(out, c)
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		b, ok := cm.EncodeRune(r)
		if !ok && r >= 0x80 && r <= 0x9F && cm.DecodeByte(byte(r)) == utf8.RuneError {
			// A byte the code page leaves undefined (0x81 in windows-1252):
			// the page's TextDecoder (WHATWG) reads it as the C1 control of
			// the same value, so that is written back as the byte.
			b, ok = byte(r), true
		}
		if !ok {
			return nil, line, false
		}
		out = append(out, b)
		i += size
	}
	return out, line, true
}
