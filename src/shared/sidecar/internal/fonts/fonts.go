// Package fonts finds and loads the fonts the image editor draws text with
// (Stage 14, ADR-0035). Two families are built in, so a watermark looks the
// same on every machine; the fonts installed on the system are listed by
// name and read only when one is used. A font file is never trusted: names
// are read through a bounded reader, sizes are capped, and a file that does
// not parse is skipped.
package fonts

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/gobolditalic"
	"golang.org/x/image/font/gofont/goitalic"
	"golang.org/x/image/font/gofont/gomono"
	"golang.org/x/image/font/gofont/gomonobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/sfnt"
)

// The built-in families. Default is used for an empty or unknown name.
const (
	Default = "Go"
	Mono    = "Go Mono"
)

// Limits of a scan and of a font file.
const (
	maxFiles    = 4000
	maxDepth    = 3
	maxFileSize = 64 << 20
	// maxLoaded system fonts are kept parsed; a CJK font is tens of megabytes.
	maxLoaded = 4
	maxName   = 128
)

// ErrNotFound: no font of that family can be loaded.
var ErrNotFound = errors.New("fonts: font not found")

// face is one style of a family: a file, and its index in a collection.
type face struct {
	path         string
	index        int
	bold, italic bool
	data         []byte // built-in fonts
}

type family struct {
	name  string
	faces []face
}

// Library lists families and loads fonts. The zero value is not usable; see
// New and System.
type Library struct {
	dirs []string

	scan     sync.Once
	mu       sync.Mutex
	families map[string]*family // by lower-case name
	names    []string
	loaded   []loadedFont // most recently used last
	builtIn  map[string]*sfnt.Font
}

type loadedFont struct {
	key  string
	font *sfnt.Font
}

// New returns a library over the given font folders, plus the built-in
// families.
func New(dirs ...string) *Library {
	l := &Library{dirs: dirs, families: map[string]*family{}, builtIn: map[string]*sfnt.Font{}}
	l.add(Default, face{data: goregular.TTF})
	l.add(Default, face{data: gobold.TTF, bold: true})
	l.add(Default, face{data: goitalic.TTF, italic: true})
	l.add(Default, face{data: gobolditalic.TTF, bold: true, italic: true})
	l.add(Mono, face{data: gomono.TTF})
	l.add(Mono, face{data: gomonobold.TTF, bold: true})
	return l
}

var (
	systemOnce sync.Once
	system     *Library
)

// System is the library over the operating system's font folders.
func System() *Library {
	systemOnce.Do(func() { system = New(SystemDirs()...) })
	return system
}

// SystemDirs lists where the operating system keeps fonts.
func SystemDirs() []string {
	home, _ := os.UserHomeDir()
	var dirs []string
	switch runtime.GOOS {
	case "windows":
		if root := os.Getenv("WINDIR"); root != "" {
			dirs = append(dirs, filepath.Join(root, "Fonts"))
		}
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			dirs = append(dirs, filepath.Join(local, "Microsoft", "Windows", "Fonts"))
		}
	case "darwin":
		dirs = append(dirs, "/System/Library/Fonts", "/Library/Fonts")
		if home != "" {
			dirs = append(dirs, filepath.Join(home, "Library", "Fonts"))
		}
	default:
		dirs = append(dirs, "/usr/share/fonts", "/usr/local/share/fonts")
		if home != "" {
			dirs = append(dirs, filepath.Join(home, ".fonts"), filepath.Join(home, ".local", "share", "fonts"))
		}
	}
	return dirs
}

func (l *Library) add(name string, f face) {
	key := strings.ToLower(name)
	fam := l.families[key]
	if fam == nil {
		fam = &family{name: name}
		l.families[key] = fam
	}
	for _, have := range fam.faces {
		if have.bold == f.bold && have.italic == f.italic {
			return // the first file of a style wins
		}
	}
	fam.faces = append(fam.faces, f)
}

// Families lists the family names: the built-in ones first, then the
// system's in alphabetical order. The first call scans the font folders
// (names only); ctx bounds it, and a scan that was cut short is not repeated.
func (l *Library) Families(ctx context.Context) []string {
	l.scan.Do(func() { l.scanDirs(ctx) })
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.names == nil {
		var rest []string
		for _, fam := range l.families {
			if fam.name != Default && fam.name != Mono {
				rest = append(rest, fam.name)
			}
		}
		sort.Slice(rest, func(i, j int) bool { return strings.ToLower(rest[i]) < strings.ToLower(rest[j]) })
		l.names = append([]string{Default, Mono}, rest...)
	}
	return append([]string(nil), l.names...)
}

func fontFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".ttf", ".otf", ".ttc", ".otc":
		return true
	}
	return false
}

func (l *Library) scanDirs(ctx context.Context) {
	files := 0
	for _, root := range l.dirs {
		base := strings.Count(filepath.Clean(root), string(filepath.Separator))
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if ctx.Err() != nil || files >= maxFiles {
				return fs.SkipAll
			}
			if d.IsDir() {
				if strings.Count(filepath.Clean(path), string(filepath.Separator))-base > maxDepth {
					return fs.SkipDir
				}
				return nil
			}
			// Regular files only: a link could point anywhere.
			if !d.Type().IsRegular() || !fontFile(d.Name()) {
				return nil
			}
			files++
			l.readNames(path)
			return nil
		})
	}
}

// readNames records the families of a font file, reading its name table
// only.
func (l *Library) readNames(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.Size() > maxFileSize || fi.Size() < 12 {
		return
	}
	var fonts []*sfnt.Font
	switch strings.ToLower(filepath.Ext(path)) {
	case ".ttc", ".otc":
		c, err := sfnt.ParseCollectionReaderAt(f)
		if err != nil {
			return
		}
		for i := 0; i < c.NumFonts() && i < 32; i++ {
			if one, err := c.Font(i); err == nil {
				fonts = append(fonts, one)
			} else {
				fonts = append(fonts, nil)
			}
		}
	default:
		one, err := sfnt.ParseReaderAt(f)
		if err != nil {
			return
		}
		fonts = []*sfnt.Font{one}
	}
	var buf sfnt.Buffer
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, one := range fonts {
		if one == nil {
			continue
		}
		name, err := one.Name(&buf, sfnt.NameIDFamily)
		name = strings.TrimSpace(name)
		// Names starting with a dot are the system's own interface fonts.
		if err != nil || name == "" || len(name) > maxName || strings.HasPrefix(name, ".") || !printable(name) {
			continue
		}
		sub, _ := one.Name(&buf, sfnt.NameIDSubfamily)
		sub = strings.ToLower(sub)
		l.add(name, face{path: path, index: i,
			bold:   strings.Contains(sub, "bold") || strings.Contains(sub, "black") || strings.Contains(sub, "heavy"),
			italic: strings.Contains(sub, "italic") || strings.Contains(sub, "oblique")})
	}
}

func printable(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == 0xfffd {
			return false
		}
	}
	return true
}

// Known reports whether the family is built in or was found by a scan that
// already ran. It never scans.
func (l *Library) Known(name string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.families[strings.ToLower(name)]
	return ok
}

// Font returns the font of a family in the style closest to the one asked
// for. An empty or unknown family gives the built-in default, so text can
// always be drawn; ErrNotFound is returned only if even that fails.
func (l *Library) Font(name string, bold, italic bool) (*sfnt.Font, error) {
	l.mu.Lock()
	fam := l.families[strings.ToLower(name)]
	l.mu.Unlock()
	if fam == nil && name != "" && name != Default {
		// The name may come from a recipe made before this run scanned.
		l.scan.Do(func() { l.scanDirs(context.Background()) })
		l.mu.Lock()
		fam = l.families[strings.ToLower(name)]
		l.mu.Unlock()
	}
	if fam != nil {
		if f, err := l.load(fam, bold, italic); err == nil {
			return f, nil
		}
	}
	l.mu.Lock()
	fam = l.families[strings.ToLower(Default)]
	l.mu.Unlock()
	f, err := l.load(fam, bold, italic)
	if err != nil {
		return nil, ErrNotFound
	}
	return f, nil
}

// pick chooses the face whose style differs least from the one asked for.
func pick(faces []face, bold, italic bool) face {
	best, bestScore := faces[0], 3
	for _, f := range faces {
		score := 0
		if f.bold != bold {
			score++
		}
		if f.italic != italic {
			score++
		}
		if score < bestScore {
			best, bestScore = f, score
		}
	}
	return best
}

func (l *Library) load(fam *family, bold, italic bool) (*sfnt.Font, error) {
	if fam == nil || len(fam.faces) == 0 {
		return nil, ErrNotFound
	}
	f := pick(fam.faces, bold, italic)
	key := f.path + "#" + string(rune('0'+f.index))
	if f.data != nil {
		key = fam.name + "/" + map[bool]string{true: "b"}[f.bold] + map[bool]string{true: "i"}[f.italic]
	}
	l.mu.Lock()
	if f.data != nil {
		if have := l.builtIn[key]; have != nil {
			l.mu.Unlock()
			return have, nil
		}
	}
	for i, have := range l.loaded {
		if have.key == key {
			l.loaded = append(append(l.loaded[:i:i], l.loaded[i+1:]...), have)
			l.mu.Unlock()
			return have.font, nil
		}
	}
	l.mu.Unlock()

	data := f.data
	if data == nil {
		fi, err := os.Lstat(f.path)
		if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxFileSize {
			return nil, ErrNotFound
		}
		if data, err = os.ReadFile(f.path); err != nil {
			return nil, err
		}
	}
	var parsed *sfnt.Font
	var err error
	switch strings.ToLower(filepath.Ext(f.path)) {
	case ".ttc", ".otc":
		var c *sfnt.Collection
		if c, err = sfnt.ParseCollection(data); err == nil {
			parsed, err = c.Font(f.index)
		}
	default:
		parsed, err = sfnt.Parse(data)
	}
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if f.data != nil {
		l.builtIn[key] = parsed
		return parsed, nil
	}
	l.loaded = append(l.loaded, loadedFont{key: key, font: parsed})
	if len(l.loaded) > maxLoaded {
		l.loaded = append([]loadedFont(nil), l.loaded[len(l.loaded)-maxLoaded:]...)
	}
	return parsed, nil
}
