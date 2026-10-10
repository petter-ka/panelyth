//go:build windows

package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// purgeTrash removes from the current user's recycle bin exactly the items
// whose original path is inside dir: each has an $I file (metadata with the
// original path) and an $R file (the data) with the same suffix.
func purgeTrash(dir string) (int, error) {
	tok := windows.GetCurrentProcessToken()
	user, err := tok.GetTokenUser()
	if err != nil {
		return 0, err
	}
	bin := filepath.Join(filepath.VolumeName(dir)+`\`, "$Recycle.Bin", user.User.Sid.String())
	infos, err := filepath.Glob(filepath.Join(bin, "$I*"))
	if err != nil {
		return 0, err
	}
	prefix := strings.ToLower(filepath.Clean(dir)) + `\`
	n := 0
	for _, info := range infos {
		orig, ok := originalPath(info)
		if !ok || !strings.HasPrefix(strings.ToLower(orig), prefix) {
			continue
		}
		data := filepath.Join(bin, "$R"+strings.TrimPrefix(filepath.Base(info), "$I"))
		if os.RemoveAll(data) == nil && os.Remove(info) == nil {
			n++
		}
	}
	return n, nil
}

// originalPath reads an $I file: version 1 has a fixed 260-character path
// at offset 24; version 2 a length at offset 24 and the path at offset 28.
func originalPath(info string) (string, bool) {
	b, err := os.ReadFile(info)
	if err != nil || len(b) < 28 {
		return "", false
	}
	var raw []byte
	switch binary.LittleEndian.Uint64(b[0:8]) {
	case 1:
		raw = b[24:min(len(b), 24+520)]
	case 2:
		chars := int(binary.LittleEndian.Uint32(b[24:28]))
		raw = b[28:min(len(b), 28+2*chars)]
	default:
		return "", false
	}
	u := make([]uint16, len(raw)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	s := string(utf16.Decode(u))
	if i := strings.IndexByte(s, 0); i >= 0 {
		s = s[:i]
	}
	return s, s != ""
}
