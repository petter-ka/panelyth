package editor

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/pathkey"
)

// Recipes (Stage 16, ADR-0036): an edit list of operations that need no
// pointed position, and the rules for the files a batch writes. A recipe is
// data: it names operations, assets by id and fonts by family, and never a
// path. The folder a batch writes into is chosen in Electron main's dialog
// and travels beside the recipe.
const (
	RecipeVersion = 1
	MaxRecipeOps  = 64
	MaxRecipeName = 80
	MaxTemplate   = 120
	// MaxRecipeBytes bounds a recipe as JSON (stored or sent).
	MaxRecipeBytes = 256 << 10
)

// Output formats besides the save formats: each picture keeps its own.
const FormatKeep = "keep"

// Destinations of a batch.
const (
	DestBeside  = "beside"
	DestFolder  = "folder"
	DestReplace = "replace"
)

// Conflict policies of a batch: what happens when the name is taken.
const (
	ConflictKeepBoth = "keepBoth"
	ConflictSkip     = "skip"
	ConflictReplace  = "replace"
)

// Default name templates: beside the original the copy must not take its
// name; in another folder it may.
const (
	TemplateBeside = "{name}-edited"
	TemplateFolder = "{name}"
)

// Output says what a batch writes.
type Output struct {
	// Format is "keep" (each picture's own; one that can't be written, WebP,
	// is saved as PNG) or a save format.
	Format string `json:"format"`
	// Quality is for JPEG (1..100); 0 is the default.
	Quality int `json:"quality,omitempty"`
	// Metadata is a metadata policy (imaging.MetaKeep, …).
	Metadata string `json:"metadata"`
	// DPI, when set, is the resolution written.
	DPI float64 `json:"dpi,omitempty"`
	// Destination: "beside" each original, one "folder", or "replace" (the
	// original goes to the trash and the result takes its name).
	Destination string `json:"destination"`
	// Template names a file without its extension, with {tokens}; empty is
	// the destination's default.
	Template string `json:"template,omitempty"`
	// Conflict: "keepBoth" (a number is added), "skip", or "replace" (the
	// file with that name goes to the trash first).
	Conflict string `json:"conflict"`
}

// Recipe is what a batch does to every picture.
type Recipe struct {
	Version int              `json:"version"`
	Ops     imaging.EditList `json:"ops"`
	Output  Output           `json:"output"`
}

// Problem is one reason a recipe cannot run, as a code the UI words.
type Problem struct {
	// Code: version, tooManyOps, notBatchable, invalidOp, missingAsset,
	// unknownToken, template, format, quality, metadata, dpi, destination,
	// conflict.
	Code string `json:"code"`
	// Op is the operation the problem is about ("" for the output).
	Op string `json:"op"`
	// Detail is the token, or what the operation's check said.
	Detail string `json:"detail"`
}

// Problems lists everything that keeps the recipe from running: all of it,
// so the editor can show the list before Run. hasAsset reports whether an
// asset is registered; nil skips that check (a stored recipe is checked for
// its assets when it is run).
func (r Recipe) Problems(hasAsset func(id string) bool) []Problem {
	var out []Problem
	add := func(code, op, detail string) { out = append(out, Problem{Code: code, Op: op, Detail: detail}) }
	if r.Version != RecipeVersion {
		add("version", "", strconv.Itoa(r.Version))
	}
	if len(r.Ops) > MaxRecipeOps {
		add("tooManyOps", "", strconv.Itoa(MaxRecipeOps))
	}
	for i, op := range r.Ops {
		if i >= MaxRecipeOps {
			break
		}
		one := imaging.EditList{op}
		switch {
		case !imaging.KnownOp(op.Kind):
			add("invalidOp", op.Kind, "unknown operation")
		case !one.Batchable():
			add("notBatchable", op.Kind, "")
		default:
			if err := one.Validate(); err != nil {
				add("invalidOp", op.Kind, strings.TrimPrefix(err.Error(), imaging.ErrInvalidEdit.Error()+": "))
			}
		}
	}
	if hasAsset != nil {
		for _, op := range r.Ops {
			for _, id := range (imaging.EditList{op}).AssetIDs() {
				if !hasAsset(id) {
					add("missingAsset", op.Kind, "")
				}
			}
		}
	}
	o := r.Output
	if _, ok := imaging.SaveFormats[o.Format]; !ok && o.Format != FormatKeep {
		add("format", "", o.Format)
	}
	if o.Quality != 0 && (o.Quality < imaging.MinQuality || o.Quality > imaging.MaxQuality) {
		add("quality", "", strconv.Itoa(o.Quality))
	}
	if o.Metadata != imaging.MetaKeep && o.Metadata != imaging.MetaStrip && o.Metadata != imaging.MetaStripGPS {
		add("metadata", "", o.Metadata)
	}
	if !(o.DPI >= 0 && o.DPI <= 10000) {
		add("dpi", "", "")
	}
	switch o.Destination {
	case DestBeside, DestFolder:
	case DestReplace:
		// The original keeps its name, so it keeps its format.
		if o.Format != FormatKeep {
			add("format", "", o.Format)
		}
	default:
		add("destination", "", o.Destination)
	}
	if o.Conflict != ConflictKeepBoth && o.Conflict != ConflictSkip && o.Conflict != ConflictReplace {
		add("conflict", "", o.Conflict)
	}
	switch {
	case len(o.Template) > MaxTemplate:
		add("template", "", "too long")
	case strings.ContainsAny(o.Template, `/\`) || strings.ContainsRune(o.Template, 0):
		add("template", "", "a name, not a path")
	default:
		var literal strings.Builder
		eachToken(o.Template, func(s string) { literal.WriteString(s) }, func(name string, _ int, _ string) {
			if !knownToken(name) {
				add("unknownToken", "", name)
			}
		})
		if cleanPart(literal.String()) != literal.String() {
			add("template", "", "characters a file name can't have")
		}
	}
	return out
}

// ErrRecipe wraps the first problem of a recipe that cannot run.
var ErrRecipe = errors.New("editor: the recipe cannot run")

// ParseRecipe reads a recipe from JSON that is not trusted (a stored row, an
// import): bounded, with unknown fields refused.
func ParseRecipe(raw []byte) (Recipe, error) {
	var r Recipe
	if len(raw) > MaxRecipeBytes {
		return r, ErrRecipe
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return r, ErrRecipe
	}
	if r.Ops == nil {
		r.Ops = imaging.EditList{}
	}
	return r, nil
}

// knownToken: a token every picture has, the picture's number in the batch,
// or an EXIF tag (empty for a picture without it).
func knownToken(name string) bool {
	if name == "n" || strings.HasPrefix(name, "exif.") && len(name) > len("exif.") {
		return true
	}
	for _, t := range imaging.TokenNames {
		if t == name {
			return true
		}
	}
	return false
}

func tokenByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_'
}

// eachToken calls fn for every {token} of t, with the width of {n:3} (0
// without one); text between tokens goes to lit.
func eachToken(t string, lit func(string), fn func(name string, width int, raw string)) {
	for i := 0; i < len(t); {
		open := strings.IndexByte(t[i:], '{')
		if open < 0 {
			lit(t[i:])
			return
		}
		lit(t[i : i+open])
		i += open
		end := i + 1
		for end < len(t) && tokenByte(t[end]) {
			end++
		}
		name, width, stop := strings.ToLower(t[i+1:end]), 0, end
		if stop < len(t) && t[stop] == ':' && stop+2 < len(t) && t[stop+1] >= '1' && t[stop+1] <= '9' {
			width, stop = int(t[stop+1]-'0'), stop+2
		}
		if stop < len(t) && t[stop] == '}' && name != "" && (width == 0 || name == "n") {
			fn(name, width, t[i:stop+1])
			i = stop + 1
			continue
		}
		lit("{")
		i++
	}
}

func templateTokens(t string) []string {
	var names []string
	eachToken(t, func(string) {}, func(name string, _ int, _ string) { names = append(names, name) })
	return names
}

// NeedsFacts reports whether naming a file reads the picture (its date, its
// size or its EXIF tags) and not just its name.
func (o Output) NeedsFacts() bool {
	for _, name := range templateTokens(o.template()) {
		switch name {
		case "n", "name", "filename", "ext", "folder":
		default:
			return true
		}
	}
	return false
}

func (o Output) template() string {
	switch {
	case o.Template != "":
		return o.Template
	case o.Destination == DestFolder:
		return TemplateFolder
	}
	return TemplateBeside
}

// cleanPart makes a token's value fit into a file name.
func cleanPart(v string) string {
	var b strings.Builder
	for _, r := range v {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`<>:"/\|?*`, r) {
			b.WriteByte('-')
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Name builds the file name of picture n (from 1) under ext. An EXIF tag the
// picture does not carry is empty.
func (o Output) Name(n int, ext string, lookup func(name string) (string, bool)) (string, error) {
	var b strings.Builder
	eachToken(o.template(), func(s string) { b.WriteString(s) }, func(name string, width int, raw string) {
		if name == "n" {
			s := strconv.Itoa(n)
			for len(s) < width {
				s = "0" + s
			}
			b.WriteString(s)
			return
		}
		v, ok := lookup(name)
		switch {
		case ok:
			if len(v) > imaging.MaxTokenValue {
				v = v[:imaging.MaxTokenValue]
			}
			b.WriteString(cleanPart(v))
		case !strings.HasPrefix(name, "exif."):
			b.WriteString(raw)
		}
	})
	stem := strings.TrimRight(strings.TrimSpace(b.String()), ". ")
	if stem == "" {
		return "", fileops.Errorf(fileops.CodeInvalidName, "the name template gives this picture no name")
	}
	name := stem + "." + ext
	if err := fileops.ValidateName(name); err != nil {
		return "", err
	}
	return name, nil
}

// --- a picture's tokens, read when first asked for ---

// Facts are a picture's tokens (Tokens). The name and the folder come from
// the path; anything else reads the file's header once.
type Facts struct {
	src    Source
	once   sync.Once
	tokens map[string]string
}

// NewFacts describes the picture at src.
func NewFacts(src Source) *Facts { return &Facts{src: src} }

// Token implements the lookup of a name template and of text in a recipe.
func (f *Facts) Token(name string) (string, bool) {
	base := filepath.Base(f.src.Path)
	ext := filepath.Ext(base)
	switch name {
	case "filename":
		return base, true
	case "name":
		return strings.TrimSuffix(base, ext), true
	case "ext":
		return strings.TrimPrefix(ext, "."), true
	case "folder":
		return filepath.Base(filepath.Dir(f.src.Path)), true
	}
	f.once.Do(f.load)
	v, ok := f.tokens[name]
	return v, ok
}

func (f *Facts) load() {
	fi, err := os.Stat(f.src.Path)
	if err != nil {
		return
	}
	w, h := 0, 0
	var info []imaging.InfoGroup
	if probe, err := imaging.DefaultRegistry().ProbeFile(f.src.Path, f.src.Ext); err == nil {
		w, h = probe.DisplaySize()
		format := probe.Decoder.Name()
		if meta, err := imaging.ReadMetadata(f.src.Path, format); err == nil {
			info = exifInfo(f.src.Path, format, meta.Exif)
		}
	}
	f.tokens = Tokens(f.src, w, h, fi.ModTime(), info)
}

// ResourcesFor gives a batch picture's run the manager's assets and fonts
// and the picture's own tokens.
func (m *Manager) ResourcesFor(f *Facts) imaging.Resources {
	return &resources{assets: m.assets, fonts: m.fonts, lookup: f.Token}
}

// HasAsset reports whether an asset is registered.
func (m *Manager) HasAsset(id string) bool { return m.assets.has(id) }

// Animated reports a picture the editor does not edit: a GIF with more than
// one frame or an animated WebP.
func Animated(path, format string) bool { return animated(path, format) }

// --- where a batch's files go ---

// Target is where one picture of a batch goes.
type Target struct {
	Path   string
	Format string
	// Replace: the result takes the original's place (which goes to the
	// trash). TrashDest: another file has that name and goes to the trash
	// first (the "replace" conflict policy).
	Replace   bool
	TrashDest bool
	// Skip is why the picture is left out: "conflict" (the name is taken
	// and the policy skips) or "notWritable" (its format can't be written,
	// so it can't be replaced).
	Skip string
}

// Namer gives the pictures of one batch their destinations, in order: it
// counts them for {n} and never hands out a name twice.
type Namer struct {
	out    Output
	folder string
	n      int
	taken  map[string]struct{}
	// IsSource reports whether a path key is one of the batch's originals
	// (nil: unknown); such a file is never replaced by another's result.
	IsSource func(key string) bool
	// Exists reports whether a path is taken on disk (os.Lstat when nil).
	Exists func(path string) bool
}

// NewNamer names the files of a batch; folder is the destination folder of
// DestFolder (a clean absolute path).
func NewNamer(out Output, folder string) *Namer {
	return &Namer{out: out, folder: folder, taken: map[string]struct{}{}}
}

func fileKey(path string) string {
	return pathkey.ChildKey(pathkey.DirKey(filepath.Dir(path)), filepath.Base(path), false)
}

func (nm *Namer) exists(path string) bool {
	if nm.Exists != nil {
		return nm.Exists(path)
	}
	_, err := os.Lstat(path)
	return err == nil
}

// Next is the destination of the next picture. decoder is the family that
// reads it ("jpeg", "webp", …).
func (nm *Namer) Next(src Source, decoder string, lookup func(name string) (string, bool)) (Target, error) {
	nm.n++
	own := imaging.FormatOf(decoder)
	if nm.out.Destination == DestReplace {
		if own == "" {
			return Target{Skip: "notWritable"}, nil
		}
		nm.taken[fileKey(src.Path)] = struct{}{}
		return Target{Path: src.Path, Format: own, Replace: true}, nil
	}
	format, ext := nm.out.Format, ""
	if format == FormatKeep {
		// The original's own spelling of its extension stays (".jpeg").
		if format, ext = own, src.Ext; own == "" {
			format, ext = "png", "png"
		}
	}
	if ext == "" {
		ext = imaging.SaveFormats[format]
	}
	name, err := nm.out.Name(nm.n, ext, lookup)
	if err != nil {
		return Target{}, err
	}
	dir := nm.folder
	if nm.out.Destination != DestFolder {
		dir = filepath.Dir(src.Path)
	}
	t := Target{Path: filepath.Join(dir, name), Format: format}
	key := fileKey(t.Path)
	_, mine := nm.taken[key]
	if mine || nm.exists(t.Path) {
		// A result never lands on its own original, on another original of
		// the batch or on a file the batch wrote: those get a number.
		safe := !mine && key != fileKey(src.Path) && (nm.IsSource == nil || !nm.IsSource(key))
		switch {
		case nm.out.Conflict == ConflictSkip:
			return Target{Skip: "conflict"}, nil
		case nm.out.Conflict == ConflictReplace && safe:
			t.TrashDest = true
		default:
			free, ok := fileops.UniqueName(name, false, func(c string) bool {
				p := filepath.Join(dir, c)
				_, used := nm.taken[fileKey(p)]
				return used || nm.exists(p)
			})
			if !ok {
				return Target{}, fileops.Errorf(fileops.CodeExists, "no free name for %s", name)
			}
			t.Path = filepath.Join(dir, free)
			key = fileKey(t.Path)
		}
	}
	nm.taken[key] = struct{}{}
	return t, nil
}

// --- built-in recipes ---

// Builtin is a recipe that ships with the app: an ordinary recipe the user
// can change and save as their own.
type Builtin struct {
	// Key names it for the UI, which words it in the user's language.
	Key    string
	Name   string
	Recipe Recipe
}

func op(kind, params string) imaging.Op {
	return imaging.Op{Kind: kind, Params: json.RawMessage(params)}
}

func builtin(key, name, template, format string, quality int, ops ...imaging.Op) Builtin {
	return Builtin{Key: key, Name: name, Recipe: Recipe{Version: RecipeVersion, Ops: ops, Output: Output{
		Format: format, Quality: quality, Metadata: imaging.MetaKeep, Destination: DestBeside,
		Template: template, Conflict: ConflictKeepBoth}}}
}

// Builtins are the recipes every installation starts with.
func Builtins() []Builtin {
	return []Builtin{
		builtin("web1600", "Web, 1600 px", "{name}-web", "jpeg", 85,
			op("resize", `{"mode":"fit","w":1600,"h":1600,"noEnlarge":true}`),
			op("sharpen", `{"amount":60,"radius":0.8}`)),
		builtin("email1024", "Email, 1024 px", "{name}-email", "jpeg", 80,
			op("resize", `{"mode":"fit","w":1024,"h":1024,"noEnlarge":true}`)),
		builtin("thumb256", "Thumbnail, 256 px square", "{name}-thumb", "jpeg", 85,
			op("resize", `{"mode":"fill","w":256,"h":256}`)),
		// The longer edge is 15 cm at 300 dpi; the shorter follows the picture.
		builtin("print10x15", "Print, 10 × 15 cm at 300 dpi", "{name}-print", "jpeg", 95,
			op("resize", `{"mode":"fit","w":1772,"h":1772}`),
			op("dpi", `{"x":300}`)),
		builtin("watermark", "Watermark, bottom right", "{name}-marked", FormatKeep, 0,
			op("watermark", `{"kind":"text","text":"© {year}","size":4,"color":"#ffffff","opacity":70,"shadow":true,"anchor":"se","margin":3}`)),
		builtin("bwContrast", "Black and white, more contrast", "{name}-bw", FormatKeep, 0,
			op("grayscale", `{"method":"luminance"}`),
			op("lighting", `{"contrast":30}`)),
	}
}
