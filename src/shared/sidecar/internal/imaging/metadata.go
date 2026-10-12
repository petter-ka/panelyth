package imaging

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"math"
	"os"
)

// Metadata is what an edited picture carries over from its source
// (ADR-0035): the EXIF block, the ICC profile, the XMP packet, a PNG's text
// chunks and the resolution. It is read without touching pixels and with
// fixed limits.
type Metadata struct {
	// Exif is a TIFF structure (without the "Exif\0\0" prefix of a JPEG).
	Exif []byte
	ICC  []byte
	XMP  []byte
	// Text holds a PNG's tEXt, zTXt and iTXt chunks (type and data), for a
	// PNG saved as PNG.
	Text []PNGChunk
	DPI  DPI
	// BitDepth is the bits per channel of the source when it is known to be
	// more than 8 (the editor reduces it and says so).
	BitDepth int
}

// PNGChunk is a PNG chunk kept as it was.
type PNGChunk struct {
	Type string
	Data []byte
}

// Limits of what is carried over.
const (
	maxICCBytes  = 8 << 20
	maxXMPBytes  = 1 << 20
	maxTextBytes = 1 << 20
	maxSegments  = 2000
)

// Metadata policies of a save.
const (
	MetaKeep     = "keep"
	MetaStrip    = "strip"
	MetaStripGPS = "stripGps"
)

const (
	xmpPrefix  = "http://ns.adobe.com/xap/1.0/\x00"
	iccPrefix  = "ICC_PROFILE\x00"
	exifPrefix = "Exif\x00\x00"
	xmpKeyword = "XML:com.adobe.xmp"
)

// ReadMetadata reads the metadata of an image file of the given decoder
// family ("jpeg", "png", "tiff", "bmp", "webp", "gif"). A file without any,
// or with a broken block, yields what was readable; the error is for I/O.
func ReadMetadata(path, format string) (Metadata, error) {
	f, err := os.Open(path)
	if err != nil {
		return Metadata{}, err
	}
	defer f.Close()
	var m Metadata
	switch format {
	case "jpeg":
		readJPEGMeta(bufio.NewReaderSize(f, 64<<10), &m)
	case "png":
		readPNGMeta(bufio.NewReaderSize(f, 64<<10), &m)
	case "webp":
		readWebPMeta(bufio.NewReaderSize(f, 64<<10), &m)
	case "bmp":
		var h [46]byte
		if _, err := io.ReadFull(f, h[:]); err == nil && h[0] == 'B' && h[1] == 'M' && binary.LittleEndian.Uint32(h[14:]) >= 40 {
			x, y := float64(binary.LittleEndian.Uint32(h[38:])), float64(binary.LittleEndian.Uint32(h[42:]))
			if x > 0 && y > 0 {
				m.DPI = DPI{X: roundDPI(x * 0.0254), Y: roundDPI(y * 0.0254)}
			}
		}
	case "tiff":
		if fi, err := f.Stat(); err == nil {
			readTIFFMeta(f, fi.Size(), &m)
		}
	}
	if m.DPI.X <= 0 && len(m.Exif) > 0 {
		m.DPI = exifDPI(m.Exif)
	}
	return m, nil
}

// roundDPI removes the error of a round trip through pixels per meter.
func roundDPI(v float64) float64 {
	if r := math.Round(v); math.Abs(v-r) < 0.02 {
		return r
	}
	return math.Round(v*100) / 100
}

func exifDPI(exif []byte) DPI {
	t, first, err := openTIFF(bytes.NewReader(exif), int64(len(exif)))
	if err != nil {
		return DPI{}
	}
	entries, _, err := t.ifd(first)
	if err != nil {
		return DPI{}
	}
	return tiffDPI(t, entries)
}

func tiffDPI(t *tiffReader, entries []ifdEntry) DPI {
	var x, y float64
	unit := uint32(2)
	for _, e := range entries {
		switch e.tag {
		case 0x011A:
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) {
				x = v[0]
			}
		case 0x011B:
			if v := t.rationals(e, 1); len(v) == 1 && finite(v[0]) {
				y = v[0]
			}
		case 0x0128:
			if v, ok := t.uint(e); ok {
				unit = v
			}
		}
	}
	return resolutionDPI(x, y, unit)
}

func readJPEGMeta(r *bufio.Reader, m *Metadata) {
	var soi [2]byte
	if _, err := io.ReadFull(r, soi[:]); err != nil || soi[0] != 0xFF || soi[1] != 0xD8 {
		return
	}
	var icc [][]byte
	iccTotal := 0
	for range maxSegments {
		b, err := r.ReadByte()
		if err != nil || b != 0xFF {
			return
		}
		marker, err := r.ReadByte()
		for err == nil && marker == 0xFF { // fill bytes
			marker, err = r.ReadByte()
		}
		if err != nil || marker == 0xDA || marker == 0xD9 {
			break
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8) {
			continue
		}
		var l [2]byte
		if _, err := io.ReadFull(r, l[:]); err != nil {
			break
		}
		size := int(binary.BigEndian.Uint16(l[:])) - 2
		if size < 0 {
			break
		}
		if marker != 0xE0 && marker != 0xE1 && marker != 0xE2 {
			if _, err := r.Discard(size); err != nil {
				break
			}
			continue
		}
		seg := make([]byte, size)
		if _, err := io.ReadFull(r, seg); err != nil {
			break
		}
		switch {
		case marker == 0xE0 && len(seg) >= 12 && string(seg[:5]) == "JFIF\x00":
			x, y := float64(binary.BigEndian.Uint16(seg[8:])), float64(binary.BigEndian.Uint16(seg[10:]))
			switch seg[7] {
			case 1:
				m.DPI = resolutionDPI(x, y, 2)
			case 2:
				m.DPI = resolutionDPI(x, y, 3)
				m.DPI = DPI{roundDPI(m.DPI.X), roundDPI(m.DPI.Y)}
			}
		case marker == 0xE1 && m.Exif == nil && bytes.HasPrefix(seg, []byte(exifPrefix)):
			m.Exif = seg[len(exifPrefix):]
		case marker == 0xE1 && m.XMP == nil && bytes.HasPrefix(seg, []byte(xmpPrefix)):
			m.XMP = seg[len(xmpPrefix):]
		case marker == 0xE2 && len(seg) > len(iccPrefix)+2 && bytes.HasPrefix(seg, []byte(iccPrefix)):
			// Chunks are numbered from 1; they are kept in file order,
			// which is how writers emit them.
			part := seg[len(iccPrefix)+2:]
			if iccTotal += len(part); iccTotal <= maxICCBytes {
				icc = append(icc, part)
			}
		}
	}
	if len(icc) > 0 && iccTotal <= maxICCBytes {
		m.ICC = bytes.Join(icc, nil)
	}
}

func readPNGMeta(r *bufio.Reader, m *Metadata) {
	var sig [8]byte
	if _, err := io.ReadFull(r, sig[:]); err != nil || string(sig[:]) != "\x89PNG\r\n\x1a\n" {
		return
	}
	textTotal := 0
	for range maxSegments {
		var h [8]byte
		if _, err := io.ReadFull(r, h[:]); err != nil {
			return
		}
		size, typ := int(binary.BigEndian.Uint32(h[:4])), string(h[4:])
		if typ == "IDAT" || typ == "IEND" || size < 0 || size > 64<<20 {
			return
		}
		keep := typ == "IHDR" || typ == "pHYs" || typ == "eXIf" ||
			(typ == "iCCP" && size <= maxICCBytes) ||
			((typ == "tEXt" || typ == "zTXt" || typ == "iTXt") && size <= maxTextBytes)
		if !keep {
			if _, err := r.Discard(size + 4); err != nil {
				return
			}
			continue
		}
		data := make([]byte, size)
		if _, err := io.ReadFull(r, data); err != nil {
			return
		}
		if _, err := r.Discard(4); err != nil { // CRC
			return
		}
		switch typ {
		case "IHDR":
			if size >= 13 && data[8] > 8 {
				m.BitDepth = int(data[8])
			}
		case "pHYs":
			if size >= 9 && data[8] == 1 {
				x, y := float64(binary.BigEndian.Uint32(data)), float64(binary.BigEndian.Uint32(data[4:]))
				if x > 0 && y > 0 {
					m.DPI = DPI{X: roundDPI(x * 0.0254), Y: roundDPI(y * 0.0254)}
				}
			}
		case "eXIf":
			if size <= 1<<20 {
				m.Exif = data
			}
		case "iCCP":
			// name\0, compression method (0), deflate stream
			if i := bytes.IndexByte(data, 0); i >= 0 && i+2 <= len(data) && data[i+1] == 0 {
				if zr, err := zlib.NewReader(bytes.NewReader(data[i+2:])); err == nil {
					if icc, err := io.ReadAll(io.LimitReader(zr, maxICCBytes+1)); err == nil && len(icc) <= maxICCBytes {
						m.ICC = icc
					}
				}
			}
		default:
			if xmp := pngXMP(typ, data); xmp != nil {
				m.XMP = xmp
			} else if textTotal += size; textTotal <= maxTextBytes {
				m.Text = append(m.Text, PNGChunk{Type: typ, Data: data})
			}
		}
	}
}

// pngXMP returns the packet of an uncompressed XMP iTXt chunk.
func pngXMP(typ string, data []byte) []byte {
	head := xmpKeyword + "\x00\x00\x00"
	if typ != "iTXt" || !bytes.HasPrefix(data, []byte(head)) {
		return nil
	}
	rest := data[len(head):]
	for range 2 { // language tag, translated keyword
		i := bytes.IndexByte(rest, 0)
		if i < 0 {
			return nil
		}
		rest = rest[i+1:]
	}
	if len(rest) > maxXMPBytes {
		return nil
	}
	return rest
}

func readWebPMeta(r *bufio.Reader, m *Metadata) {
	var h [12]byte
	if _, err := io.ReadFull(r, h[:]); err != nil || string(h[:4]) != "RIFF" || string(h[8:]) != "WEBP" {
		return
	}
	for range maxSegments {
		var c [8]byte
		if _, err := io.ReadFull(r, c[:]); err != nil {
			return
		}
		size, typ := int(binary.LittleEndian.Uint32(c[4:])), string(c[:4])
		padded := size + size&1
		limit := 0
		switch typ {
		case "ICCP":
			limit = maxICCBytes
		case "EXIF", "XMP ":
			limit = maxXMPBytes
		}
		if size < 0 || size > limit {
			if _, err := r.Discard(padded); err != nil {
				return
			}
			continue
		}
		data := make([]byte, padded)
		if _, err := io.ReadFull(r, data); err != nil {
			return
		}
		data = data[:size]
		switch typ {
		case "ICCP":
			m.ICC = data
		case "EXIF":
			m.Exif = bytes.TrimPrefix(data, []byte(exifPrefix))
		case "XMP ":
			m.XMP = data
		}
	}
}

func readTIFFMeta(r io.ReaderAt, size int64, m *Metadata) {
	t, first, err := openTIFF(r, size)
	if err != nil {
		return
	}
	entries, _, err := t.ifd(first)
	if err != nil {
		return
	}
	m.DPI = tiffDPI(t, entries)
	for _, e := range entries {
		switch e.tag {
		case 0x0102: // BitsPerSample
			if v := t.uints(e, 8); len(v) > 0 && v[0] > 8 {
				m.BitDepth = int(v[0])
			}
		case 0x8773: // ICC profile
			if n := e.size(); (e.typ == 7 || e.typ == 1) && n > 0 && n <= maxICCBytes {
				t.budget += n // the profile has its own limit
				if icc, err := t.data(e, maxICCBytes); err == nil {
					m.ICC = bytes.Clone(icc)
				}
			}
		}
	}
}

// For keeps what a save with the given policy writes for a w×h result:
// the EXIF block is patched to the new picture (orientation 1, the new
// size and resolution, no stale thumbnail), and "strip" keeps only the
// color profile, which is not about the photographer.
func (m Metadata) For(policy string, w, h int, dpi DPI) Metadata {
	out := Metadata{ICC: m.ICC, DPI: dpi}
	if policy == MetaStrip {
		return out
	}
	stripGPS := policy == MetaStripGPS
	if len(m.Exif) > 0 {
		out.Exif = PatchExif(m.Exif, w, h, dpi, stripGPS)
	}
	// An XMP packet repeats the location in its own tags; without a parser
	// for it, a packet that mentions GPS is left out.
	if len(m.XMP) > 0 && !(stripGPS && bytes.Contains(m.XMP, []byte("GPS"))) {
		out.XMP = m.XMP
	}
	out.Text = m.Text
	return out
}

// PatchExif returns a copy of an EXIF block that describes the edited
// picture: orientation 1 (the pixels are upright now), the new pixel size,
// the resolution when it is known, the thumbnail removed and blanked (it
// would show the picture before the edit), and, with stripGPS, the GPS
// directory removed and blanked. Unreadable input comes back unchanged
// except that nothing is patched; nil when it is not a TIFF structure.
func PatchExif(exif []byte, w, h int, dpi DPI, stripGPS bool) []byte {
	out := bytes.Clone(exif)
	t, first, err := openTIFF(bytes.NewReader(exif), int64(len(exif)))
	if err != nil {
		return nil
	}
	entries, next, err := t.ifd(first)
	if err != nil {
		return nil
	}
	put := func(e ifdEntry, v uint32) {
		if e.count != 1 {
			return
		}
		switch e.typ {
		case 3:
			copy(out[e.pos:e.pos+4], []byte{0, 0, 0, 0})
			t.bo.PutUint16(out[e.pos:], uint16(min(v, 0xFFFF)))
		case 4:
			t.bo.PutUint32(out[e.pos:], v)
		}
	}
	putRational := func(e ifdEntry, v float64) {
		if e.typ != 5 || e.count != 1 {
			return
		}
		off := t.where(e)
		if off < 0 || off+8 > int64(len(out)) {
			return
		}
		num, den := uint32(math.Round(v)), uint32(1)
		if v != math.Trunc(v) {
			num, den = uint32(math.Round(v*100)), 100
		}
		t.bo.PutUint32(out[off:], num)
		t.bo.PutUint32(out[off+4:], den)
	}
	zero := func(off, n int64) {
		if off >= 0 && n > 0 && off+n <= int64(len(out)) {
			clear(out[off : off+n])
		}
	}
	gps := -1
	for i, e := range entries {
		switch e.tag {
		case 0x0112:
			put(e, 1)
		case 0x0100:
			put(e, uint32(w))
		case 0x0101:
			put(e, uint32(h))
		case 0x011A:
			if dpi.X > 0 {
				putRational(e, dpi.X)
			}
		case 0x011B:
			if dpi.Y > 0 {
				putRational(e, dpi.Y)
			}
		case 0x0128:
			if dpi.X > 0 {
				put(e, 2)
			}
		case 0x8769:
			if v, ok := t.uint(e); ok {
				if sub, _, err := t.ifd(int64(v)); err == nil {
					for _, s := range sub {
						switch s.tag {
						case 0xA002:
							put(s, uint32(w))
						case 0xA003:
							put(s, uint32(h))
						}
					}
				}
			}
		case 0x8825:
			gps = i
		}
	}
	// The thumbnail directory: blank the thumbnail and unlink it.
	if next != 0 {
		if thumb, _, err := t.ifd(next); err == nil {
			var off, n uint32
			for _, e := range thumb {
				switch e.tag {
				case 0x0201:
					off, _ = t.uint(e)
				case 0x0202:
					n, _ = t.uint(e)
				}
			}
			zero(int64(off), int64(n))
		}
	}
	count := int64(len(entries))
	nextPos := first + 2 + count*12
	if nextPos+4 <= int64(len(out)) {
		t.bo.PutUint32(out[nextPos:], 0)
	}
	if stripGPS && gps >= 0 {
		if v, ok := t.uint(entries[gps]); ok {
			if sub, _, err := t.ifd(int64(v)); err == nil {
				for _, e := range sub {
					if e.size() > 4 {
						zero(t.where(e), e.size())
					}
				}
				zero(int64(v), 2+int64(len(sub))*12+4)
			}
		}
		// Close the gap in the directory: later entries move up one slot.
		start := first + 2 + int64(gps)*12
		end := first + 2 + count*12
		if end+4 <= int64(len(out)) {
			copy(out[start:], out[start+12:end])
			t.bo.PutUint16(out[first:], uint16(count-1))
			clear(out[end-12 : end+4]) // the new next-directory offset (0) and the freed slot
		}
	}
	return out
}

// --- writers ---

// jpegSegments builds the segments that follow SOI: JFIF with the
// resolution, EXIF, XMP and the ICC profile. A block too large for a
// segment is left out.
func jpegSegments(m Metadata) []byte {
	var b bytes.Buffer
	seg := func(marker byte, parts ...[]byte) {
		n := 2
		for _, p := range parts {
			n += len(p)
		}
		if n > 0xFFFF {
			return
		}
		b.Write([]byte{0xFF, marker, byte(n >> 8), byte(n)})
		for _, p := range parts {
			b.Write(p)
		}
	}
	jfif := []byte{'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0}
	if d := m.DPI; d.X >= 1 && d.Y >= 1 && d.X <= 65535 && d.Y <= 65535 {
		jfif[7] = 1
		binary.BigEndian.PutUint16(jfif[8:], uint16(math.Round(d.X)))
		binary.BigEndian.PutUint16(jfif[10:], uint16(math.Round(d.Y)))
	}
	seg(0xE0, jfif)
	if len(m.Exif) > 0 {
		seg(0xE1, []byte(exifPrefix), m.Exif)
	}
	if len(m.XMP) > 0 {
		seg(0xE1, []byte(xmpPrefix), m.XMP)
	}
	const chunk = 0xFFFF - 2 - len(iccPrefix) - 2
	if n := (len(m.ICC) + chunk - 1) / chunk; n > 0 && n <= 255 {
		for i := range n {
			part := m.ICC[i*chunk : min((i+1)*chunk, len(m.ICC))]
			seg(0xE2, []byte(iccPrefix), []byte{byte(i + 1), byte(n)}, part)
		}
	}
	return b.Bytes()
}

func pngChunk(b *bytes.Buffer, typ string, data []byte) {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(data)))
	b.Write(n[:])
	crc := crc32.NewIEEE()
	crc.Write([]byte(typ))
	crc.Write(data)
	b.WriteString(typ)
	b.Write(data)
	binary.BigEndian.PutUint32(n[:], crc.Sum32())
	b.Write(n[:])
}

// pngChunks builds the chunks that follow IHDR: the profile, the
// resolution, EXIF, XMP and the text chunks.
func pngChunks(m Metadata) []byte {
	var b bytes.Buffer
	if len(m.ICC) > 0 {
		var z bytes.Buffer
		z.WriteString("ICC profile\x00\x00")
		zw := zlib.NewWriter(&z)
		_, _ = zw.Write(m.ICC)
		_ = zw.Close()
		pngChunk(&b, "iCCP", z.Bytes())
	}
	if d := m.DPI; d.X >= 1 && d.Y >= 1 {
		var p [9]byte
		binary.BigEndian.PutUint32(p[:], uint32(math.Round(d.X/0.0254)))
		binary.BigEndian.PutUint32(p[4:], uint32(math.Round(d.Y/0.0254)))
		p[8] = 1 // per meter
		pngChunk(&b, "pHYs", p[:])
	}
	if len(m.Exif) > 0 {
		pngChunk(&b, "eXIf", m.Exif)
	}
	if len(m.XMP) > 0 {
		pngChunk(&b, "iTXt", append([]byte(xmpKeyword+"\x00\x00\x00\x00\x00"), m.XMP...))
	}
	for _, c := range m.Text {
		pngChunk(&b, c.Type, c.Data)
	}
	return b.Bytes()
}

// injectWriter writes extra bytes into a stream after its first `after`
// bytes: after SOI of a JPEG, after IHDR of a PNG. The encoders write those
// headers first, so the stream never has to be buffered.
type injectWriter struct {
	w      io.Writer
	after  int
	inject []byte
	seen   int
}

func (iw *injectWriter) Write(p []byte) (int, error) {
	if iw.inject == nil {
		return iw.w.Write(p)
	}
	head := min(iw.after-iw.seen, len(p))
	n, err := iw.w.Write(p[:head])
	iw.seen += n
	if err != nil || iw.seen < iw.after {
		return n, err
	}
	extra := iw.inject
	iw.inject = nil
	if _, err := iw.w.Write(extra); err != nil {
		return n, err
	}
	m, err := iw.w.Write(p[head:])
	return n + m, err
}

// patchTIFF adds the resolution and the ICC profile to a TIFF written by
// x/image/tiff, which has neither: a new directory with the extra entries
// is appended and the header points at it. The old directory stays in the
// file, unused.
func patchTIFF(f *os.File, dpi DPI, icc []byte) error {
	hasDPI := dpi.X >= 1 && dpi.Y >= 1
	if !hasDPI && len(icc) == 0 {
		return nil
	}
	var h [8]byte
	if _, err := f.ReadAt(h[:], 0); err != nil {
		return err
	}
	var bo binary.ByteOrder = binary.LittleEndian
	if string(h[:2]) == "MM" {
		bo = binary.BigEndian
	}
	off := int64(bo.Uint32(h[4:]))
	var cnt [2]byte
	if _, err := f.ReadAt(cnt[:], off); err != nil {
		return err
	}
	n := int(bo.Uint16(cnt[:]))
	if n > maxIFDEntries {
		return errors.New("imaging: unexpected TIFF directory")
	}
	old := make([]byte, n*12)
	if _, err := f.ReadAt(old, off+2); err != nil {
		return err
	}
	end, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	var tail bytes.Buffer
	if end&1 == 1 {
		tail.WriteByte(0)
	}
	pos := func() uint32 { return uint32(end) + uint32(tail.Len()) }
	type entry struct {
		tag uint16
		raw [12]byte
	}
	var entries []entry
	replaced := map[uint16]bool{}
	add := func(tag, typ uint16, count, value uint32) {
		var e entry
		e.tag = tag
		bo.PutUint16(e.raw[:], tag)
		bo.PutUint16(e.raw[2:], typ)
		bo.PutUint32(e.raw[4:], count)
		if typ == 3 {
			bo.PutUint16(e.raw[8:], uint16(value))
		} else {
			bo.PutUint32(e.raw[8:], value)
		}
		entries = append(entries, e)
		replaced[tag] = true
	}
	if hasDPI {
		for i, v := range []float64{dpi.X, dpi.Y} {
			var r [8]byte
			bo.PutUint32(r[:], uint32(math.Round(v*100)))
			bo.PutUint32(r[4:], 100)
			add(uint16(0x011A+i), 5, 1, pos())
			tail.Write(r[:])
		}
		add(0x0128, 3, 1, 2)
	}
	if len(icc) > 0 {
		add(0x8773, 7, uint32(len(icc)), pos())
		tail.Write(icc)
		if tail.Len()&1 == 1 {
			tail.WriteByte(0)
		}
	}
	for i := range n {
		var e entry
		copy(e.raw[:], old[i*12:])
		e.tag = bo.Uint16(e.raw[:])
		if !replaced[e.tag] {
			entries = append(entries, e)
		}
	}
	// Directory entries are sorted by tag.
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && entries[j-1].tag > entries[j].tag; j-- {
			entries[j-1], entries[j] = entries[j], entries[j-1]
		}
	}
	if (int(end)+tail.Len())&1 == 1 {
		tail.WriteByte(0)
	}
	ifd := pos()
	var c [2]byte
	bo.PutUint16(c[:], uint16(len(entries)))
	tail.Write(c[:])
	for _, e := range entries {
		tail.Write(e.raw[:])
	}
	tail.Write([]byte{0, 0, 0, 0})
	if _, err := f.WriteAt(tail.Bytes(), end); err != nil {
		return err
	}
	bo.PutUint32(h[4:], ifd)
	_, err = f.WriteAt(h[4:], 4)
	return err
}

// patchBMP writes the resolution into a BMP's header.
func patchBMP(f *os.File, dpi DPI) error {
	if dpi.X < 1 || dpi.Y < 1 {
		return nil
	}
	var h [18]byte
	if _, err := f.ReadAt(h[:], 0); err != nil {
		return err
	}
	if binary.LittleEndian.Uint32(h[14:]) < 40 {
		return nil
	}
	var p [8]byte
	binary.LittleEndian.PutUint32(p[:], uint32(math.Round(dpi.X/0.0254)))
	binary.LittleEndian.PutUint32(p[4:], uint32(math.Round(dpi.Y/0.0254)))
	_, err := f.WriteAt(p[:], 38)
	return err
}
