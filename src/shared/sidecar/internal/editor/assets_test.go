package editor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/fonts"
	"panelyth/sidecar/internal/imaging"
)

// logo is a small picture with a transparent ground.
func writeLogo(t testing.TB, dir, name string, w, h int) string {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := h / 4; y < h*3/4; y++ {
		for x := w / 4; x < w*3/4; x++ {
			img.SetNRGBA(x, y, color.NRGBA{255, 0, 0, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAssetsAreValidatedAndNamedByContent(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{Fonts: fonts.New()})
	ctx := context.Background()
	path := writeLogo(t, dir, "logo.png", 400, 200)
	asset, thumb, err := m.AddAsset(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(asset.ID) || asset.Name != "logo.png" || asset.Width != 400 || asset.Height != 200 {
		t.Fatalf("%+v", asset)
	}
	// The thumbnail is a frame file: main serves it under the frames' rule.
	if !regexp.MustCompile(`^[0-9a-f]{24}-\d\.png$`).MatchString(filepath.Base(thumb.File)) || filepath.Base(filepath.Dir(thumb.File)) != "edit" ||
		thumb.Width != 128 || thumb.Height != 64 {
		t.Fatalf("thumbnail %+v", thumb)
	}
	if tf, err := os.Open(thumb.File); err != nil {
		t.Fatal(err)
	} else {
		cfg, err := png.DecodeConfig(tf)
		tf.Close()
		if err != nil || cfg.Width != 128 {
			t.Fatalf("thumbnail file: %v", err)
		}
	}
	// The id is the content: a copy under another name is the same asset, and
	// the extension is not believed.
	data, _ := os.ReadFile(path)
	copyPath := filepath.Join(dir, "copy.jpg")
	_ = os.WriteFile(copyPath, data, 0o644)
	same, _, err := m.AddAsset(ctx, copyPath)
	if err != nil || same.ID != asset.ID || m.Assets() != 1 {
		t.Fatalf("a copy: %+v %v (%d assets)", same, err, m.Assets())
	}

	refused := func(name string, path string) {
		t.Helper()
		if _, _, err := m.AddAsset(ctx, path); !errors.Is(err, ErrAsset) {
			t.Errorf("%s: %v", name, err)
		}
	}
	text := filepath.Join(dir, "notes.png")
	_ = os.WriteFile(text, []byte("not a picture at all, only named like one"), 0o644)
	refused("text named .png", text)
	// A header that claims a huge size is refused before any decode.
	huge := filepath.Join(dir, "huge.png")
	_ = os.WriteFile(huge, pngWithSize(data, 9000, 100), 0o644)
	refused("9000 px wide", huge)
	big := filepath.Join(dir, "big.png")
	_ = os.WriteFile(big, append(append([]byte(nil), data...), make([]byte, MaxAssetBytes)...), 0o644)
	refused("more than 16 MB", big)
	refused("a folder", dir)
	bmp := filepath.Join(dir, "x.bmp")
	_ = os.WriteFile(bmp, []byte("BM\x00\x00\x00\x00"), 0o644)
	refused("a type that is not offered", bmp)
	// A truncated picture has a readable header but no pixels.
	cut := filepath.Join(dir, "cut.png")
	_ = os.WriteFile(cut, data[:len(data)/2], 0o644)
	refused("truncated", cut)
	// An animation.
	anim := filepath.Join(dir, "anim.gif")
	frame := image.NewPaletted(image.Rect(0, 0, 8, 8), color.Palette{color.Black, color.White})
	var gbuf bytes.Buffer
	_ = gif.EncodeAll(&gbuf, &gif.GIF{Image: []*image.Paletted{frame, frame}, Delay: []int{5, 5}})
	_ = os.WriteFile(anim, gbuf.Bytes(), 0o644)
	refused("animated GIF", anim)
	// A link is not followed.
	link := filepath.Join(dir, "link.png")
	if os.Symlink(path, link) == nil {
		refused("a symbolic link", link)
	}
	if _, _, err := m.AddAsset(ctx, filepath.Join(dir, "missing.png")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a missing file: %v", err)
	}
	if m.Assets() != 1 {
		t.Fatalf("%d assets after the refusals", m.Assets())
	}

	// At most MaxAssets are remembered; the oldest goes first.
	for i := range MaxAssets {
		p := writeLogo(t, dir, "n.png", 16+i, 16)
		if _, _, err := m.AddAsset(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	if m.Assets() != MaxAssets {
		t.Fatalf("%d assets remembered", m.Assets())
	}
	if _, err := m.assets.image(ctx, asset.ID); !errors.Is(err, imaging.ErrInvalidEdit) {
		t.Fatalf("the oldest asset is still there: %v", err)
	}
}

func TestSessionDrawsAssetsTextAndTokens(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{Fonts: fonts.New()})
	ctx := context.Background()
	src := writeJPEG(t, dir, "holiday.jpg", 1200, 800)
	stamp := time.Date(2026, 3, 9, 14, 5, 0, 0, time.Local)
	if err := os.Chtimes(src.Path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	s, err := m.Open(ctx, 1, src)
	if err != nil {
		t.Fatal(err)
	}
	// The picture's facts, for text.
	for name, want := range map[string]string{"name": "holiday", "filename": "holiday.jpg", "ext": "jpg", "date": "2026-03-09",
		"time": "14:05", "year": "2026", "month": "03", "day": "09", "width": "1200", "height": "800", "folder": filepath.Base(dir)} {
		if got, ok := s.Resources().Token(name); !ok || got != want {
			t.Errorf("token %s = %q, want %q", name, got, want)
		}
	}
	if _, ok := s.Resources().Token("exif.model"); ok {
		t.Error("a picture without EXIF has an exif token")
	}
	frame := func(rev int64, js string) (RenderResult, []byte) {
		t.Helper()
		res, err := s.Render(ctx, RenderRequest{Rev: rev, Edits: edits(t, js), MaxEdge: 600})
		if err != nil {
			t.Fatalf("%s: %v", js, err)
		}
		data, err := os.ReadFile(res.File)
		if err != nil {
			t.Fatal(err)
		}
		return res, data
	}
	_, plain := frame(1, `[]`)
	_, named := frame(2, `[{"op":"watermark","p":{"text":"{name} {width}","size":20,"anchor":"c"}}]`)
	_, literal := frame(3, `[{"op":"watermark","p":{"text":"holiday 1200","size":20,"anchor":"c"}}]`)
	if bytes.Equal(plain, named) || !bytes.Equal(named, literal) {
		t.Fatal("the tokens of a watermark are not this picture's name and width")
	}

	logo, _, err := m.AddAsset(ctx, writeLogo(t, dir, "logo.png", 200, 100))
	if err != nil {
		t.Fatal(err)
	}
	stamped := `[{"op":"watermark","p":{"kind":"image","assetId":"` + logo.ID + `","size":30,"anchor":"nw"}},{"op":"border","p":{"width":5}}]`
	res, withLogo := frame(4, stamped)
	if bytes.Equal(withLogo, plain) || res.OutWidth != 1200+80 || res.OutHeight != 800+80 {
		t.Fatalf("logo frame: %+v", res)
	}
	// An asset this manager does not know is an invalid edit, not a crash.
	if _, err := s.Render(ctx, RenderRequest{Rev: 5, MaxEdge: 600,
		Edits: edits(t, `[{"op":"frameMask","p":{"shape":"custom","assetId":"00000000000000000000000000000000"}}]`)}); !errors.Is(err, imaging.ErrInvalidEdit) {
		t.Fatalf("unknown asset: %v", err)
	}

	// A save draws the same list at full size, and still does after the
	// session has been closed (the job keeps the resources).
	dest := filepath.Join(dir, "out.png")
	req := SaveRequest{Source: src, Size: s.Size, MtimeNs: s.MtimeNs, Edits: edits(t, stamped), Dest: dest,
		Format: "png", Policy: imaging.MetaKeep, Res: s.Resources()}
	m.Close(s.ID)
	saved, err := Save(ctx, req)
	if err != nil || saved.Width != 1280 || saved.Height != 880 {
		t.Fatalf("save: %+v %v", saved, err)
	}
	f, _ := os.Open(dest)
	out, err := png.Decode(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	// The frame is white, the logo's red square is where the mark was put:
	// 30 % of 800 px wide, so 240 × 120, its square in the middle half.
	if r, g, b, _ := out.At(5, 5).RGBA(); r>>8 != 255 || g>>8 != 255 || b>>8 != 255 {
		t.Errorf("frame pixel: %d %d %d", r>>8, g>>8, b>>8)
	}
	if r, g, b, _ := out.At(40+120, 40+60).RGBA(); r>>8 < 240 || g>>8 > 20 || b>>8 > 20 {
		t.Errorf("logo pixel: %d %d %d", r>>8, g>>8, b>>8)
	}

	// The asset's file changed. The pixels that were decoded are still the
	// asset (its id is its content); once they have to be read again, lists
	// that name it stop rendering, with a reason.
	s2, _ := m.Open(ctx, 1, src)
	writeLogo(t, dir, "logo.png", 201, 100)
	if _, err := s2.Render(ctx, RenderRequest{Rev: 1, Edits: edits(t, stamped), MaxEdge: 600}); err != nil {
		t.Fatalf("the decoded asset: %v", err)
	}
	m.assets.dropDecoded()
	_, err = s2.Render(ctx, RenderRequest{Rev: 2, Edits: edits(t, stamped+" "), MaxEdge: 300})
	if !errors.Is(err, imaging.ErrInvalidEdit) || !strings.Contains(err.Error(), "logo.png") {
		t.Fatalf("a changed asset file: %v", err)
	}
	// Dropped assets are gone.
	again, _, _ := m.AddAsset(ctx, filepath.Join(dir, "logo.png"))
	m.DropAsset(again.ID)
	if m.Assets() != 1 { // the first registration, by its old content
		t.Fatalf("%d assets", m.Assets())
	}
	// Fonts: the built-in families are always offered.
	if names := m.Fonts(ctx); len(names) != 2 || names[0] != fonts.Default {
		t.Fatalf("fonts %v", names)
	}
}

func TestTokensFromExif(t *testing.T) {
	info := []imaging.InfoGroup{{Name: "camera", Items: []imaging.InfoItem{{ID: "Make", Value: "Panelyth"}, {ID: "Model", Value: "Model X"}, {ID: "LensModel", Value: ""}}}}
	tok := Tokens(Source{Path: filepath.Join("C:", "photos", "trip", "IMG.0412.JPEG")}, 6000, 4000, time.Date(2025, 12, 31, 23, 59, 0, 0, time.UTC), info)
	for name, want := range map[string]string{"name": "IMG.0412", "ext": "JPEG", "folder": "trip", "exif.make": "Panelyth", "exif.model": "Model X", "date": "2025-12-31"} {
		if tok[name] != want {
			t.Errorf("%s = %q, want %q", name, tok[name], want)
		}
	}
	if _, ok := tok["exif.lensmodel"]; ok {
		t.Error("an empty tag became a token")
	}
	for _, name := range imaging.TokenNames {
		if _, ok := tok[name]; !ok {
			t.Errorf("token %q is promised but missing", name)
		}
	}
}

func TestEyesAreFoundInTheEditedPicture(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{Fonts: fonts.New()})
	ctx := context.Background()
	// Skin with two red pupils, level, ten pupil widths apart.
	img := image.NewNRGBA(image.Rect(0, 0, 800, 600))
	for y := range 600 {
		for x := range 800 {
			img.SetNRGBA(x, y, color.NRGBA{214, 168, 140, 255})
			for _, cx := range [2]int{300, 500} {
				if (x-cx)*(x-cx)+(y-300)*(y-300) <= 100 {
					img.SetNRGBA(x, y, color.NRGBA{215, 40, 45, 255})
				}
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "portrait.png")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := m.Open(ctx, 1, Source{EntryID: 9, Path: path, Ext: "png"})
	if err != nil {
		t.Fatal(err)
	}
	eyes, err := s.Eyes(ctx, nil)
	if err != nil || len(eyes) != 2 {
		t.Fatalf("eyes %v: %v", eyes, err)
	}
	for i, cx := range [2]float64{300.0 / 800, 500.0 / 800} {
		e := eyes[i]
		if mid := e.X + e.W/2; mid < cx-0.01 || mid > cx+0.01 || e.Y+e.H/2 < 0.49 || e.Y+e.H/2 > 0.51 || e.W < 0.025 || e.W > 0.08 {
			t.Errorf("eye %d: %+v", i, e)
		}
	}
	// They are found in the picture as it is edited: cropped to its left half
	// the same pupils sit elsewhere; on its side the pair is not level and is
	// left alone (a pair of lights one above the other is not a pair of eyes).
	half, err := s.Eyes(ctx, edits(t, `[{"op":"crop","p":{"rect":{"x":0.25,"y":0,"w":0.5,"h":1}}}]`))
	if err != nil || len(half) != 2 || half[0].X+half[0].W/2 < 0.24 || half[0].X+half[0].W/2 > 0.26 {
		t.Fatalf("cropped: %v %v", half, err)
	}
	if turned, err := s.Eyes(ctx, edits(t, `[{"op":"rotate","p":{"angle":90}}]`)); err != nil || len(turned) != 0 {
		t.Fatalf("on its side: %v %v", turned, err)
	}
	fixed := fmt.Sprintf(`[{"op":"redeye","p":{"rect":{"x":%g,"y":%g,"w":%g,"h":%g}}},{"op":"redeye","p":{"rect":{"x":%g,"y":%g,"w":%g,"h":%g}}}]`,
		eyes[0].X, eyes[0].Y, eyes[0].W, eyes[0].H, eyes[1].X, eyes[1].Y, eyes[1].W, eyes[1].H)
	if left, err := s.Eyes(ctx, edits(t, fixed)); err != nil || len(left) != 0 {
		t.Fatalf("after the fix: %v %v", left, err)
	}
	if _, err := s.Eyes(ctx, edits(t, `[{"op":"nope","p":{}}]`)); !errors.Is(err, imaging.ErrInvalidEdit) {
		t.Fatalf("invalid list: %v", err)
	}
	m.Close(s.ID)
	if _, err := s.Eyes(ctx, nil); !errors.Is(err, ErrGone) {
		t.Fatalf("closed session: %v", err)
	}
}
