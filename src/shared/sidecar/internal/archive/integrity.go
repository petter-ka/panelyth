package archive

import (
	"context"
	"io"
)

// Test reads every entry of an archive, so checksums (zip CRC-32, gzip and
// bzip2 checks) and the structure are verified; nothing is written. It
// returns the number of files read.
func Test(ctx context.Context, path string, format Format, tool *Tool, counted func(int64)) (int, error) {
	if format == Format7z {
		return tool.test(ctx, path)
	}
	r, err := openReader(path, format, counted)
	if err != nil {
		return 0, err
	}
	defer r.close()
	files := 0
	buf := make([]byte, 256<<10)
	err = r.walk(ctx, func(h *Header) bool { return h.Kind == KindFile }, func(h *Header, data io.Reader) error {
		if h.Kind != KindFile || h.Unsafe != "" {
			return nil
		}
		if h.Encrypted {
			return ErrEncrypted
		}
		files++
		if data == nil {
			return nil
		}
		_, err := io.CopyBuffer(io.Discard, data, buf)
		return err
	})
	return files, err
}
