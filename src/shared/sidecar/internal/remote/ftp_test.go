package remote

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/encoding/charmap"

	"panelyth/sidecar/internal/remote/ftptest"
)

var bg = context.Background()

// tree writes the folder every server of these tests serves.
func tree(t testing.TB) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, text string, mtime time.Time) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	recent := time.Now().Add(-48 * time.Hour).Truncate(time.Minute)
	write("readme.txt", "hello", recent)
	write("with space.txt", "x", recent)
	write("pub/a.bin", strings.Repeat("0123456789abcdef", 4096), recent)
	write("pub/old.txt", "old", time.Date(2019, 1, 15, 0, 0, 0, 0, time.UTC))
	if err := os.Mkdir(filepath.Join(root, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func serve(t testing.TB, o ftptest.Options) *ftptest.Server {
	t.Helper()
	if o.Root == "" {
		o.Root = tree(t)
	}
	s, err := ftptest.Start(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func plain(s *ftptest.Server) Options {
	return Options{Host: s.Host, Port: s.Port, TLS: TLSNone}
}

func dial(t testing.TB, o Options) Client {
	t.Helper()
	c, err := Dial(bg, o)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func names(entries []Entry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Name
		if e.Kind == KindDir {
			out[i] += "/"
		}
	}
	slices.Sort(out)
	return out
}

func TestListDialects(t *testing.T) {
	want := []string{"empty/", "pub/", "readme.txt", "with space.txt"}
	for name, o := range map[string]ftptest.Options{
		"MLSD":                 {},
		"LIST, unix":           {NoMLSD: true},
		"LIST, dos":            {NoMLSD: true, DOSList: true},
		"LIST without flags":   {NoMLSD: true, NoListFlags: true},
		"PASV instead of EPSV": {NoEPSV: true},
	} {
		t.Run(name, func(t *testing.T) {
			s := serve(t, o)
			c := dial(t, plain(s))
			if c.Features().MLSD == o.NoMLSD {
				t.Errorf("features %+v", c.Features())
			}
			entries, rejected, err := c.List(bg, "/")
			if err != nil || rejected != 0 {
				t.Fatalf("list: %v, %d rejected", err, rejected)
			}
			if got := names(entries); !slices.Equal(got, want) {
				t.Fatalf("names %v, want %v", got, want)
			}
			for _, e := range entries {
				if e.Name == "readme.txt" && (e.Size != 5 || e.MtimeNs == 0) {
					t.Errorf("readme.txt: %+v", e)
				}
			}
			// A folder with a date years back, and an empty one.
			sub, _, err := c.List(bg, "/pub")
			if err != nil || !slices.Equal(names(sub), []string{"a.bin", "old.txt"}) {
				t.Fatalf("/pub: %v %v", names(sub), err)
			}
			for _, e := range sub {
				if e.Name == "old.txt" && time.Unix(0, e.MtimeNs).UTC().Year() != 2019 {
					t.Errorf("old.txt dated %v", time.Unix(0, e.MtimeNs).UTC())
				}
			}
			if none, _, err := c.List(bg, "/empty"); err != nil || len(none) != 0 {
				t.Errorf("/empty: %v %v", none, err)
			}
			if _, _, err := c.List(bg, "/nowhere"); err == nil {
				t.Error("a folder that is not there was listed")
			}
			// The connection is still good after a refused command.
			if err := c.Noop(bg); err != nil || c.Broken() {
				t.Errorf("after an error: %v, broken %v", err, c.Broken())
			}
		})
	}
}

func TestActiveMode(t *testing.T) {
	s := serve(t, ftptest.Options{})
	o := plain(s)
	o.Active = true
	c := dial(t, o)
	entries, _, err := c.List(bg, "/pub")
	if err != nil || len(entries) != 2 {
		t.Fatalf("list: %v %v", entries, err)
	}
	var buf bytes.Buffer
	if err := c.Retrieve(bg, "/readme.txt", 0, &buf); err != nil || buf.String() != "hello" {
		t.Errorf("retrieve: %q %v", buf.String(), err)
	}
	if s.Count("PORT") == 0 || s.Count("EPSV") != 0 || s.Count("PASV") != 0 {
		t.Errorf("commands %v", s.Commands())
	}
}

func TestNamesInACodePage(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "café.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := serve(t, ftptest.Options{Root: root, Encoding: charmap.Windows1252})
	// Read as UTF-8, the name is not valid text: it is left out and counted.
	c := dial(t, plain(s))
	entries, rejected, err := c.List(bg, "/")
	if err != nil || len(entries) != 0 || rejected != 1 {
		t.Fatalf("as UTF-8: %v, %d rejected, %v", entries, rejected, err)
	}
	// With the connection's encoding it is listed, and its name goes back the same way.
	o := plain(s)
	o.Encoding = "windows-1252"
	c = dial(t, o)
	entries, rejected, err = c.List(bg, "/")
	if err != nil || rejected != 0 || len(entries) != 1 || entries[0].Name != "café.txt" {
		t.Fatalf("as windows-1252: %v, %d rejected, %v", entries, rejected, err)
	}
	var buf bytes.Buffer
	if err := c.Retrieve(bg, "/café.txt", 0, &buf); err != nil || buf.String() != "x" {
		t.Errorf("retrieve: %q %v", buf.String(), err)
	}
	// A name the code page cannot write is refused before anything is sent.
	if err := c.Mkdir(bg, "/日本"); !errors.Is(err, ErrUnsafeName) {
		t.Errorf("an unencodable name: %v", err)
	}
	if _, err := Dial(bg, Options{Host: s.Host, Port: s.Port, TLS: TLSNone, Encoding: "klingon"}); err == nil {
		t.Error("an unknown encoding was accepted")
	}
}

func TestHostileNamesAreNotListed(t *testing.T) {
	s := serve(t, ftptest.Options{ExtraList: []string{
		"type=file;size=1; ../evil.txt",
		"type=file;size=1; sub/evil.txt",
		`type=file;size=1; back\slash.txt`,
		"type=file;size=1; bell\x07.txt",
		"type=file;size=1; ..",
		"type=file;size=1; fine.txt",
	}})
	c := dial(t, plain(s))
	entries, rejected, err := c.List(bg, "/empty")
	if err != nil {
		t.Fatal(err)
	}
	if got := names(entries); !slices.Equal(got, []string{"fine.txt"}) || rejected != 4 {
		t.Errorf("listed %v, %d rejected", got, rejected)
	}
	// Nothing with a line end is ever sent as a command.
	for _, bad := range []string{"/a\r\nDELE /readme.txt", "/a\nb", "/nul\x00"} {
		if err := c.Delete(bg, bad); !errors.Is(err, ErrUnsafeName) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if s.Count("DELE") != 0 {
		t.Errorf("a hostile path reached the server: %v", s.Commands())
	}
}

func TestPassiveAddressOfTheServerIsIgnored(t *testing.T) {
	// The server claims its data port is on another host (a TEST-NET address
	// that answers nothing). The client goes to the control connection's host.
	s := serve(t, ftptest.Options{NoEPSV: true, PasvHost: "192.0.2.1"})
	c := dial(t, plain(s))
	start := time.Now()
	entries, _, err := c.List(bg, "/")
	if err != nil || len(entries) != 4 {
		t.Fatalf("list: %v %v", entries, err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("the listing took %v: the other host was tried", d)
	}
}

func TestTransfersAndResume(t *testing.T) {
	root := tree(t)
	want, _ := os.ReadFile(filepath.Join(root, "pub", "a.bin"))
	s := serve(t, ftptest.Options{Root: root, DropAfter: 10_000})
	c := dial(t, plain(s))
	if !c.Features().Resume {
		t.Fatal("no REST")
	}
	// The first download is cut after 10,000 bytes; the connection survives it.
	var got bytes.Buffer
	if err := c.Retrieve(bg, "/pub/a.bin", 0, &got); err == nil {
		t.Fatal("a cut download was reported as complete")
	}
	if got.Len() != 10_000 || c.Broken() {
		t.Fatalf("after the cut: %d bytes, broken %v", got.Len(), c.Broken())
	}
	// It goes on where it stopped.
	if err := c.Retrieve(bg, "/pub/a.bin", int64(got.Len()), &got); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if !bytes.Equal(got.Bytes(), want) {
		t.Errorf("resumed download: %d bytes, want %d", got.Len(), len(want))
	}

	// Upload, in two parts.
	if err := c.Store(bg, "/empty/up.bin", 0, bytes.NewReader(want[:30_000])); err != nil {
		t.Fatalf("store: %v", err)
	}
	if err := c.Store(bg, "/empty/up.bin", 30_000, bytes.NewReader(want[30_000:])); err != nil {
		t.Fatalf("store resumed: %v", err)
	}
	up, _ := os.ReadFile(filepath.Join(root, "empty", "up.bin"))
	if !bytes.Equal(up, want) {
		t.Errorf("uploaded %d bytes, want %d", len(up), len(want))
	}
	if err := c.Retrieve(bg, "/pub/none.bin", 0, io.Discard); !errors.Is(err, ErrNotFound) {
		t.Errorf("a missing file: %v", err)
	}
}

func TestResumeNeedsTheServer(t *testing.T) {
	s := serve(t, ftptest.Options{NoREST: true})
	c := dial(t, plain(s))
	if c.Features().Resume {
		t.Fatal("REST reported")
	}
	if err := c.Retrieve(bg, "/readme.txt", 2, io.Discard); !errors.Is(err, ErrUnsupported) {
		t.Errorf("resume without REST: %v", err)
	}
	if s.Count("RETR") != 0 {
		t.Error("a download from the middle was started without REST")
	}
}

func TestFolderCommands(t *testing.T) {
	root := tree(t)
	s := serve(t, ftptest.Options{Root: root})
	c := dial(t, plain(s))
	if err := c.Mkdir(bg, "/new folder"); err != nil {
		t.Fatal(err)
	}
	if err := c.Mkdir(bg, "/new folder"); err == nil {
		t.Error("a folder was created twice")
	}
	if err := c.Rename(bg, "/readme.txt", "/new folder/read me.txt"); err != nil {
		t.Fatal(err)
	}
	if err := c.Rename(bg, "/nothing", "/x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("rename of a missing file: %v", err)
	}
	if err := c.Rmdir(bg, "/new folder"); err == nil {
		t.Error("a folder that is not empty was removed")
	}
	if err := c.Delete(bg, "/new folder/read me.txt"); err != nil {
		t.Fatal(err)
	}
	if err := c.Rmdir(bg, "/new folder"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "new folder")); err == nil {
		t.Error("the folder is still there")
	}
	if _, err := os.Stat(filepath.Join(root, "readme.txt")); err == nil {
		t.Error("the renamed file is still under its old name")
	}
}

func tlsServer(t testing.TB, o ftptest.Options) (*ftptest.Server, string) {
	t.Helper()
	cert, leaf, err := ftptest.SelfSigned("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	o.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	return serve(t, o), Fingerprint(leaf)
}

func TestTLSWithAnAcceptedCertificate(t *testing.T) {
	for name, implicit := range map[string]bool{"explicit": false, "implicit": true} {
		t.Run(name, func(t *testing.T) {
			s, print := tlsServer(t, ftptest.Options{Implicit: implicit, User: "alice", Password: "s3cret"})
			o := Options{Host: s.Host, Port: s.Port, TLS: TLSExplicit, User: "alice", Password: "s3cret"}
			if implicit {
				o.TLS = TLSImplicit
			}
			// A certificate nobody vouches for: refused, with its fingerprint.
			_, err := Dial(bg, o)
			var ce *CertificateError
			if !errors.As(err, &ce) || ce.Fingerprint != print || ce.Changed {
				t.Fatalf("an unverified certificate: %v", err)
			}
			if s.Count("PASS") != 0 {
				t.Fatal("the password was sent to a server that was not trusted")
			}
			// Accepted for this connection: the same certificate passes.
			o.Fingerprint = print
			c := dial(t, o)
			if !c.Features().TLS {
				t.Error("TLS not reported")
			}
			entries, _, err := c.List(bg, "/")
			if err != nil || len(entries) != 4 {
				t.Fatalf("list over TLS: %v %v", entries, err)
			}
			var buf bytes.Buffer
			if err := c.Retrieve(bg, "/pub/a.bin", 0, &buf); err != nil || buf.Len() != 65536 {
				t.Errorf("retrieve over TLS: %d bytes, %v", buf.Len(), err)
			}
			if err := c.Store(bg, "/empty/t.txt", 0, strings.NewReader("over tls")); err != nil {
				t.Errorf("store over TLS: %v", err)
			}
			if s.ClearPasswords.Load() != 0 {
				t.Error("a password crossed in the clear")
			}
			// Another certificate than the accepted one: refused, and said so.
			o.Fingerprint = strings.Repeat("ab", 32)
			_, err = Dial(bg, o)
			if !errors.As(err, &ce) || !ce.Changed || ce.Fingerprint != print {
				t.Errorf("a changed certificate: %v", err)
			}
		})
	}
}

func TestTLSIsNeverGivenUp(t *testing.T) {
	// The server has no TLS; the connection asks for it.
	s := serve(t, ftptest.Options{User: "alice", Password: "s3cret"})
	for _, mode := range []TLSMode{TLSExplicit, TLSImplicit} {
		_, err := Dial(bg, Options{Host: s.Host, Port: s.Port, TLS: mode, User: "alice", Password: "s3cret"})
		if mode == TLSExplicit && !errors.Is(err, ErrTLSRequired) {
			t.Errorf("%s: %v", mode, err)
		}
		if err == nil {
			t.Errorf("%s: connected without TLS", mode)
		}
	}
	if s.Count("USER") != 0 || s.Count("PASS") != 0 || s.ClearPasswords.Load() != 0 {
		t.Errorf("the login was sent without TLS: %v", s.Commands())
	}
	// Plain FTP is possible, when it is what the connection says.
	c := dial(t, Options{Host: s.Host, Port: s.Port, TLS: TLSNone, User: "alice", Password: "s3cret"})
	if c.Features().TLS {
		t.Error("TLS reported for plain FTP")
	}
}

func TestLoginIsRefused(t *testing.T) {
	s := serve(t, ftptest.Options{User: "alice", Password: "s3cret"})
	for name, o := range map[string]Options{
		"a wrong password": {User: "alice", Password: "guess"},
		"a wrong user":     {User: "bob", Password: "s3cret"},
		"anonymous":        {},
		// A password with a line end would start another command.
		"a password with a line end": {User: "alice", Password: "s3cret\r\nDELE /readme.txt"},
	} {
		o.Host, o.Port, o.TLS = s.Host, s.Port, TLSNone
		if _, err := Dial(bg, o); !errors.Is(err, ErrAuth) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if s.Count("DELE") != 0 {
		t.Error("a command was smuggled in with the password")
	}
	for name, o := range map[string]Options{
		"no host":       {Port: 21, TLS: TLSNone},
		"a bad port":    {Host: "127.0.0.1", Port: 70000, TLS: TLSNone},
		"a bad mode":    {Host: "127.0.0.1", Port: 21, TLS: "maybe"},
		"a host with /": {Host: "127.0.0.1/x", Port: 21, TLS: TLSNone},
	} {
		if _, err := Dial(bg, o); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestAServerThatStopsAnswering(t *testing.T) {
	t.Run("before its greeting", func(t *testing.T) {
		s := serve(t, ftptest.Options{StallOn: "GREETING"})
		ctx, cancel := context.WithTimeout(bg, 200*time.Millisecond)
		defer cancel()
		start := time.Now()
		_, err := Dial(ctx, plain(s))
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 2*time.Second {
			t.Errorf("dial: %v after %v", err, time.Since(start))
		}
	})
	t.Run("in a listing, until it is cancelled", func(t *testing.T) {
		s := serve(t, ftptest.Options{StallOn: "MLSD"})
		c := dial(t, plain(s))
		ctx, cancel := context.WithCancel(bg)
		go func() {
			<-s.Stalled
			cancel()
		}()
		start := time.Now()
		_, _, err := c.List(ctx, "/")
		if !errors.Is(err, context.Canceled) || time.Since(start) > 2*time.Second {
			t.Errorf("list: %v after %v", err, time.Since(start))
		}
		// The reply never came: the connection is not used again.
		if !c.Broken() {
			t.Error("the connection is still trusted")
		}
		if err := c.Noop(bg); !errors.Is(err, ErrClosed) {
			t.Errorf("a command after that: %v", err)
		}
	})
	t.Run("it goes away in the middle of a download", func(t *testing.T) {
		s := serve(t, ftptest.Options{StallOn: "RETR"})
		c := dial(t, plain(s))
		go func() {
			<-s.Stalled
			s.DropConnections()
		}()
		if err := c.Retrieve(bg, "/pub/a.bin", 0, io.Discard); err == nil {
			t.Error("a download from a server that went away succeeded")
		}
		if !c.Broken() {
			t.Error("the connection is still trusted")
		}
	})
}

// slowWriter lets a test cancel a download that is under way.
type slowWriter struct {
	started chan struct{}
	once    bool
}

func (w *slowWriter) Write(p []byte) (int, error) {
	if !w.once {
		w.once = true
		close(w.started)
	}
	time.Sleep(5 * time.Millisecond)
	return len(p), nil
}

func TestCancelADownload(t *testing.T) {
	root := t.TempDir()
	big := bytes.Repeat([]byte("panelyth"), 4<<20/8*8) // 32 MiB
	if err := os.WriteFile(filepath.Join(root, "big.bin"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	s := serve(t, ftptest.Options{Root: root})
	c := dial(t, plain(s))
	ctx, cancel := context.WithCancel(bg)
	w := &slowWriter{started: make(chan struct{})}
	go func() {
		<-w.started
		cancel()
	}()
	start := time.Now()
	err := c.Retrieve(ctx, "/big.bin", 0, w)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("retrieve: %v", err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("the cancel took %v", d)
	}
	// The server answered the cut transfer, so the connection goes on.
	if c.Broken() {
		t.Fatal("the connection broke on a cancel")
	}
	var buf bytes.Buffer
	if err := c.Retrieve(bg, "/big.bin", int64(len(big)-5), &buf); err != nil || buf.Len() != 5 {
		t.Errorf("after the cancel: %d bytes, %v", buf.Len(), err)
	}
}
