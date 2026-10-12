package imaging

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A bounded TIFF/EXIF reader (Stage 12, ADR-0035). It reads directories
// through an io.ReaderAt, so the same code serves the EXIF block of a JPEG
// or PNG and a TIFF file. Hostile input is expected: every offset is checked
// against the size, directories are capped and never visited twice, and the
// total bytes read are bounded. It never reads pixels.

const (
	maxIFDEntries = 512
	maxIFDs       = 16
	// maxExifRead bounds everything one read of the tags may pull in.
	maxExifRead  = 256 << 10
	maxTagString = 256
)

var errTIFF = errors.New("imaging: malformed TIFF data")

var tiffTypeSize = [13]int64{0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8}

type ifdEntry struct {
	tag, typ uint16
	count    uint32
	// pos is where the entry's 4-byte value field is.
	pos int64
	raw [4]byte
}

func (e ifdEntry) size() int64 {
	if int(e.typ) >= len(tiffTypeSize) {
		return 0
	}
	return tiffTypeSize[e.typ] * int64(e.count)
}

type tiffReader struct {
	r      io.ReaderAt
	size   int64
	bo     binary.ByteOrder
	budget int64
	seen   map[int64]bool
}

// openTIFF checks the header and returns the offset of the first directory.
func openTIFF(r io.ReaderAt, size int64) (*tiffReader, int64, error) {
	var h [8]byte
	if size < 8 {
		return nil, 0, errTIFF
	}
	if _, err := r.ReadAt(h[:], 0); err != nil {
		return nil, 0, errTIFF
	}
	t := &tiffReader{r: r, size: size, budget: maxExifRead, seen: map[int64]bool{}}
	switch string(h[:2]) {
	case "II":
		t.bo = binary.LittleEndian
	case "MM":
		t.bo = binary.BigEndian
	default:
		return nil, 0, errTIFF
	}
	if t.bo.Uint16(h[2:]) != 42 {
		return nil, 0, errTIFF
	}
	return t, int64(t.bo.Uint32(h[4:])), nil
}

func (t *tiffReader) read(off, n int64) ([]byte, error) {
	if off < 0 || n < 0 || off+n > t.size || n > t.budget {
		return nil, errTIFF
	}
	t.budget -= n
	b := make([]byte, n)
	if _, err := t.r.ReadAt(b, off); err != nil {
		return nil, errTIFF
	}
	return b, nil
}

// ifd reads the directory at off: its entries and the offset of the next
// one (0 for none). A directory is read once; a loop ends the walk.
func (t *tiffReader) ifd(off int64) ([]ifdEntry, int64, error) {
	if off < 8 || t.seen[off] || len(t.seen) >= maxIFDs {
		return nil, 0, errTIFF
	}
	t.seen[off] = true
	head, err := t.read(off, 2)
	if err != nil {
		return nil, 0, err
	}
	n := int64(t.bo.Uint16(head))
	if n > maxIFDEntries {
		return nil, 0, errTIFF
	}
	body, err := t.read(off+2, n*12+4)
	if err != nil {
		// The next-directory offset may be cut off; the entries still count.
		if body, err = t.read(off+2, n*12); err != nil {
			return nil, 0, err
		}
		body = append(body, 0, 0, 0, 0)
	}
	entries := make([]ifdEntry, n)
	for i := range entries {
		b := body[i*12:]
		e := ifdEntry{tag: t.bo.Uint16(b), typ: t.bo.Uint16(b[2:]), count: t.bo.Uint32(b[4:]), pos: off + 2 + int64(i)*12 + 8}
		copy(e.raw[:], b[8:12])
		entries[i] = e
	}
	return entries, int64(t.bo.Uint32(body[n*12:])), nil
}

// where is the absolute offset of an entry's value bytes.
func (t *tiffReader) where(e ifdEntry) int64 {
	if e.size() <= 4 {
		return e.pos
	}
	return int64(t.bo.Uint32(e.raw[:]))
}

// data returns an entry's value bytes, at most limit.
func (t *tiffReader) data(e ifdEntry, limit int64) ([]byte, error) {
	n := e.size()
	if n == 0 || n > limit {
		return nil, errTIFF
	}
	if n <= 4 {
		return e.raw[:n], nil
	}
	return t.read(t.where(e), n)
}

// uints reads up to max SHORT or LONG values.
func (t *tiffReader) uints(e ifdEntry, limit int) []uint32 {
	if (e.typ != 3 && e.typ != 4) || e.count == 0 || int(e.count) > limit {
		return nil
	}
	b, err := t.data(e, 4096)
	if err != nil {
		return nil
	}
	out := make([]uint32, e.count)
	for i := range out {
		if e.typ == 3 {
			out[i] = uint32(t.bo.Uint16(b[i*2:]))
		} else {
			out[i] = t.bo.Uint32(b[i*4:])
		}
	}
	return out
}

func (t *tiffReader) uint(e ifdEntry) (uint32, bool) {
	v := t.uints(e, 1)
	if len(v) == 0 {
		return 0, false
	}
	return v[0], true
}

// rationals reads up to max RATIONAL or SRATIONAL values.
func (t *tiffReader) rationals(e ifdEntry, limit int) []float64 {
	if (e.typ != 5 && e.typ != 10) || e.count == 0 || int(e.count) > limit {
		return nil
	}
	b, err := t.data(e, 4096)
	if err != nil {
		return nil
	}
	out := make([]float64, e.count)
	for i := range out {
		num, den := t.bo.Uint32(b[i*8:]), t.bo.Uint32(b[i*8+4:])
		switch {
		case den == 0:
			out[i] = math.NaN()
		case e.typ == 10:
			out[i] = float64(int32(num)) / float64(int32(den))
		default:
			out[i] = float64(num) / float64(den)
		}
	}
	return out
}

func (t *tiffReader) ascii(e ifdEntry) string {
	if e.typ != 2 && e.typ != 7 && e.typ != 1 {
		return ""
	}
	b, err := t.data(e, 4096)
	if err != nil {
		return ""
	}
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	s := strings.TrimSpace(strings.ToValidUTF8(string(b), "?"))
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7F {
			return ' '
		}
		return r
	}, s)
	for len(s) > maxTagString {
		_, n := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-n]
	}
	return s
}

// InfoItem is one tag for the EXIF panel. ID names the tag; Value is its
// text; Code, when set, names a value from a fixed list that the interface
// translates.
type InfoItem struct {
	ID    string `json:"id"`
	Value string `json:"value"`
	Code  string `json:"code,omitempty"`
}

// InfoGroup is a named group of tags.
type InfoGroup struct {
	Name  string     `json:"name"`
	Items []InfoItem `json:"items"`
}

// InfoGroups are the group names in display order.
var InfoGroups = []string{"camera", "lens", "exposure", "date", "gps", "software", "image"}

type infoBuilder struct{ groups map[string][]InfoItem }

func (b *infoBuilder) add(group, id, value string) {
	if value != "" {
		b.groups[group] = append(b.groups[group], InfoItem{ID: id, Value: value})
	}
}

func (b *infoBuilder) code(group, id string, v uint32, names map[uint32]string) {
	if name, ok := names[v]; ok {
		b.groups[group] = append(b.groups[group], InfoItem{ID: id, Value: name, Code: name})
	}
}

func trimFloat(v float64, decimals int) string {
	s := strconv.FormatFloat(v, 'f', decimals, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func exifDate(s string) string {
	// "2026:10:11 09:30:00" → "2026-10-11 09:30:00"
	if len(s) >= 10 && s[4] == ':' && s[7] == ':' {
		return s[:4] + "-" + s[5:7] + "-" + s[8:]
	}
	return s
}

var (
	exposurePrograms = map[uint32]string{1: "manual", 2: "program", 3: "aperturePriority", 4: "shutterPriority",
		5: "creative", 6: "action", 7: "portrait", 8: "landscape"}
	meteringModes = map[uint32]string{1: "average", 2: "centerWeighted", 3: "spot", 4: "multiSpot", 5: "pattern", 6: "partial"}
	whiteBalances = map[uint32]string{0: "auto", 1: "manual"}
	colorSpaces   = map[uint32]string{1: "sRGB", 0xFFFF: "uncalibrated"}
)

// ExifInfo reads the tags of a TIFF structure (an EXIF block or a TIFF
// file) into groups for display. Malformed data yields what was readable.
func ExifInfo(r io.ReaderAt, size int64) []InfoGroup {
	t, first, err := openTIFF(r, size)
	if err != nil {
		return nil
	}
	b := &infoBuilder{groups: map[string][]InfoItem{}}
	entries, _, err := t.ifd(first)
	if err != nil {
		return nil
	}
	var exifIFD, gpsIFD int64
	var xres, yres float64
	unit := uint32(2)
	for _, e := range entries {
		switch e.tag {
		case 0x010F:
			b.add("camera", "Make", t.ascii(e))
		case 0x0110:
			b.add("camera", "Model", t.ascii(e))
		case 0x0131:
			b.add("software", "Software", t.ascii(e))
		case 0x013B:
			b.add("software", "Artist", t.ascii(e))
		case 0x8298:
			b.add("software", "Copyright", t.ascii(e))
		case 0x010E:
			b.add("software", "ImageDescription", t.ascii(e))
		case 0x0132:
			b.add("date", "DateTime", exifDate(t.ascii(e)))
		case 0x011A:
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) {
				xres = v[0]
			}
		case 0x011B:
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) {
				yres = v[0]
			}
		case 0x0128:
			if v, ok := t.uint(e); ok {
				unit = v
			}
		case 0x8769:
			if v, ok := t.uint(e); ok {
				exifIFD = int64(v)
			}
		case 0x8825:
			if v, ok := t.uint(e); ok {
				gpsIFD = int64(v)
			}
		}
	}
	if exifIFD != 0 {
		if sub, _, err := t.ifd(exifIFD); err == nil {
			exifTags(t, b, sub)
		}
	}
	if gpsIFD != 0 {
		if sub, _, err := t.ifd(gpsIFD); err == nil {
			gpsTags(t, b, sub)
		}
	}
	if d := resolutionDPI(xres, yres, unit); d.X > 0 {
		b.add("image", "Resolution", trimFloat(d.X, 1)+" dpi")
	}
	var out []InfoGroup
	for _, name := range InfoGroups {
		if items := b.groups[name]; len(items) > 0 {
			out = append(out, InfoGroup{Name: name, Items: items})
		}
	}
	return out
}

// resolutionDPI converts TIFF resolution tags (unit 2 = inch, 3 = cm).
func resolutionDPI(x, y float64, unit uint32) DPI {
	if !(x > 0 && x < 1e6) {
		return DPI{}
	}
	if !(y > 0 && y < 1e6) {
		y = x
	}
	if unit == 3 {
		x, y = x*2.54, y*2.54
	}
	return DPI{X: x, Y: y}
}

func exifTags(t *tiffReader, b *infoBuilder, entries []ifdEntry) {
	var pw, ph uint32
	var original, offset string
	for _, e := range entries {
		switch e.tag {
		case 0x829A: // ExposureTime
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) && v[0] > 0 {
				if v[0] < 1 {
					b.add("exposure", "ExposureTime", fmt.Sprintf("1/%d s", int(math.Round(1/v[0]))))
				} else {
					b.add("exposure", "ExposureTime", trimFloat(v[0], 1)+" s")
				}
			}
		case 0x829D: // FNumber
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) && v[0] > 0 {
				b.add("exposure", "FNumber", "f/"+trimFloat(v[0], 1))
			}
		case 0x8827: // ISO
			if v := t.uints(e, 4); len(v) > 0 {
				b.add("exposure", "ISO", strconv.FormatUint(uint64(v[0]), 10))
			}
		case 0x9204: // ExposureBiasValue
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) {
				s := trimFloat(v[0], 2)
				if v[0] > 0 {
					s = "+" + s
				}
				b.add("exposure", "ExposureBias", s+" EV")
			}
		case 0x8822:
			if v, ok := t.uint(e); ok {
				b.code("exposure", "ExposureProgram", v, exposurePrograms)
			}
		case 0x9207:
			if v, ok := t.uint(e); ok {
				b.code("exposure", "MeteringMode", v, meteringModes)
			}
		case 0x9209:
			if v, ok := t.uint(e); ok {
				b.code("exposure", "Flash", v&1, map[uint32]string{0: "flashOff", 1: "flashFired"})
			}
		case 0xA403:
			if v, ok := t.uint(e); ok {
				b.code("exposure", "WhiteBalance", v, whiteBalances)
			}
		case 0x920A: // FocalLength
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) && v[0] > 0 {
				b.add("lens", "FocalLength", trimFloat(v[0], 1)+" mm")
			}
		case 0xA405:
			if v, ok := t.uint(e); ok && v > 0 {
				b.add("lens", "FocalLength35", strconv.FormatUint(uint64(v), 10)+" mm")
			}
		case 0xA433:
			b.add("lens", "LensMake", t.ascii(e))
		case 0xA434:
			b.add("lens", "LensModel", t.ascii(e))
		case 0x9003:
			original = exifDate(t.ascii(e))
		case 0x9011:
			offset = t.ascii(e)
		case 0x9004:
			b.add("date", "DateTimeDigitized", exifDate(t.ascii(e)))
		case 0xA001:
			if v, ok := t.uint(e); ok {
				b.code("image", "ColorSpace", v, colorSpaces)
			}
		case 0xA002:
			pw, _ = t.uint(e)
		case 0xA003:
			ph, _ = t.uint(e)
		}
	}
	if original != "" {
		if offset != "" {
			original += " " + offset
		}
		// The date taken leads its group.
		b.groups["date"] = append([]InfoItem{{ID: "DateTimeOriginal", Value: original}}, b.groups["date"]...)
	}
	if pw > 0 && ph > 0 {
		b.add("image", "ExifImageSize", fmt.Sprintf("%d × %d", pw, ph))
	}
}

func gpsTags(t *tiffReader, b *infoBuilder, entries []ifdEntry) {
	var latRef, lonRef string
	var lat, lon []float64
	alt, altRef, hasAlt := 0.0, uint32(0), false
	for _, e := range entries {
		switch e.tag {
		case 1:
			latRef = t.ascii(e)
		case 2:
			lat = t.rationals(e, 3)
		case 3:
			lonRef = t.ascii(e)
		case 4:
			lon = t.rationals(e, 3)
		case 5:
			if d, err := t.data(e, 4); err == nil && len(d) > 0 {
				altRef = uint32(d[0])
			}
		case 6:
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) {
				alt, hasAlt = v[0], true
			}
		}
	}
	b.add("gps", "GPSLatitude", degrees(lat, latRef, 90))
	b.add("gps", "GPSLongitude", degrees(lon, lonRef, 180))
	if hasAlt && math.Abs(alt) < 100_000 {
		if altRef == 1 {
			alt = -alt
		}
		b.add("gps", "GPSAltitude", trimFloat(alt, 1)+" m")
	}
}

// degrees formats degrees, minutes and seconds with the hemisphere.
func degrees(v []float64, ref string, limit float64) string {
	if len(v) != 3 || !finite(v[0]) || !finite(v[1]) || !finite(v[2]) {
		return ""
	}
	d := v[0] + v[1]/60 + v[2]/3600
	if d < 0 || d > limit {
		return ""
	}
	deg := math.Floor(d)
	m := math.Floor((d - deg) * 60)
	s := (d - deg - m/60) * 3600
	if len(ref) > 1 {
		ref = ref[:1]
	}
	return strings.TrimSpace(fmt.Sprintf("%d° %d′ %s″ %s", int(deg), int(m), trimFloat(s, 2), ref))
}
