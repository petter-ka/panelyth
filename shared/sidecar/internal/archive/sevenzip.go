package archive

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"fastview/sidecar/internal/fileops"
)

// Tool runs an external 7-Zip (ADR-0030, like ffmpeg in ADR-0018): 7z, rar
// and the other formats it reads, and creating 7z. The zero value and nil
// are "unavailable"; every built-in format works without it.
type Tool struct {
	Path string
}

// LocateTool finds 7-Zip: FASTVIEW_7Z (a path; "off" disables it), then
// next to the sidecar executable, then PATH (7z, 7zz, 7za).
func LocateTool(getenv func(string) string) *Tool {
	names := []string{"7z", "7zz", "7za"}
	exe := func(n string) string {
		if runtime.GOOS == "windows" {
			return n + ".exe"
		}
		return n
	}
	if v := getenv("FASTVIEW_7Z"); v != "" {
		if v == "off" {
			return &Tool{}
		}
		if fi, err := os.Stat(v); err == nil && !fi.IsDir() {
			return &Tool{Path: v}
		}
		return &Tool{}
	}
	if self, err := os.Executable(); err == nil {
		for _, n := range names {
			p := filepath.Join(filepath.Dir(self), exe(n))
			if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
				return &Tool{Path: p}
			}
		}
	}
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			return &Tool{Path: p}
		}
	}
	if runtime.GOOS == "windows" {
		for _, dir := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if dir == "" {
				continue
			}
			p := filepath.Join(dir, "7-Zip", "7z.exe")
			if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
				return &Tool{Path: p}
			}
		}
	}
	return &Tool{}
}

// Available reports whether 7-Zip was found.
func (t *Tool) Available() bool { return t != nil && t.Path != "" }

// maxToolStderr bounds what is kept of 7-Zip's error output.
const maxToolStderr = 64 << 10

// command builds a 7-Zip run: no console window, no stdin (a password
// prompt reads EOF and fails instead of hanging), UTF-8 output.
func (t *Tool) command(ctx context.Context, args ...string) (*exec.Cmd, *bytes.Buffer) {
	cmd := exec.CommandContext(ctx, t.Path, args...)
	hideWindow(cmd)
	cmd.Stdin = nil
	stderr := &bytes.Buffer{}
	cmd.Stderr = &limitedBuffer{b: stderr, n: maxToolStderr}
	cmd.WaitDelay = 2 * time.Second
	return cmd, stderr
}

type limitedBuffer struct {
	b *bytes.Buffer
	n int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.n - l.b.Len(); room > 0 {
		l.b.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// toolError maps 7-Zip's exit status and message.
func toolError(ctx context.Context, err error, stderr *bytes.Buffer) error {
	if err == nil {
		return nil
	}
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}
	msg := strings.TrimSpace(stderr.String())
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "password") || strings.Contains(low, "encrypted"):
		return ErrEncrypted
	case strings.Contains(low, "can not open the file as archive") || strings.Contains(low, "cannot open the file as archive"):
		return fmt.Errorf("%w: 7-Zip can't open this file as an archive", ErrCorrupt)
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if msg == "" {
			msg = fmt.Sprintf("7-Zip exited with code %d", ee.ExitCode())
		}
		if ee.ExitCode() == 2 {
			return fmt.Errorf("%w: %s", ErrCorrupt, firstLine(msg))
		}
		return errors.New("7-Zip: " + firstLine(msg))
	}
	return err
}

func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return s
}

// list runs "7z l -slt" and parses its blocks ("Key = value" lines,
// separated by blank lines).
func (t *Tool) list(ctx context.Context, path string, fn func(h *Header, data io.Reader) error) error {
	cmd, stderr := t.command(ctx, "l", "-slt", "-ba", "-sccUTF-8", "--", path)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	perr := parseSlt(out, fn)
	if perr != nil {
		_ = cmd.Process.Kill()
		_, _ = io.Copy(io.Discard, out)
	}
	werr := cmd.Wait()
	if perr != nil {
		return perr
	}
	return toolError(ctx, werr, stderr)
}

// parseSlt reads technical-listing blocks. Blocks describing the archive
// itself (they carry "Type") are skipped.
func parseSlt(r io.Reader, fn func(h *Header, data io.Reader) error) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	block := map[string]string{}
	flush := func() error {
		defer clear(block)
		p, ok := block["Path"]
		if !ok {
			return nil
		}
		if _, archive := block["Type"]; archive {
			return nil
		}
		h := Header{Raw: p, Kind: KindFile}
		h.Size, _ = strconv.ParseInt(block["Size"], 10, 64)
		if block["Folder"] == "+" || strings.HasPrefix(block["Attributes"], "D") {
			h.Kind, h.Size = KindDir, 0
		}
		if m := block["Modified"]; m != "" {
			if i := strings.IndexByte(m, '.'); i > 0 {
				m = m[:i]
			}
			if tm, err := time.ParseInLocation("2006-01-02 15:04:05", m, time.Local); err == nil {
				h.MtimeNs = tm.UnixNano()
			}
		}
		h.Encrypted = block["Encrypted"] == "+"
		h.Path, h.Unsafe = CleanPath(p)
		return fn(&h, nil)
	}
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		k, v, ok := strings.Cut(line, " = ")
		if !ok {
			if k, ok = strings.CutSuffix(strings.TrimSpace(line), " ="); !ok {
				continue
			}
		}
		k = strings.TrimSpace(k)
		// A new "Path" starts the next entry even without a blank line.
		if _, seen := block["Path"]; seen && k == "Path" {
			if err := flush(); err != nil {
				return err
			}
		}
		block[k] = v
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return flush()
}

// test runs "7z t".
func (t *Tool) test(ctx context.Context, path string) (int, error) {
	if !t.Available() {
		return 0, ErrNoTool
	}
	files := 0
	if err := t.list(ctx, path, func(h *Header, _ io.Reader) error {
		if h.Kind == KindFile {
			files++
		}
		return nil
	}); err != nil {
		return 0, err
	}
	cmd, stderr := t.command(ctx, "t", "-bso0", "-bsp0", "-sccUTF-8", "--", path)
	return files, toolError(ctx, cmd.Run(), stderr)
}

// extract runs "7z x" into a hidden staging folder inside the target (a
// partial name, so an interrupted job's leftovers are removed at the next
// start), then moves the staged entries in through the same checks and
// conflict handling as the built-in formats. 7-Zip never writes into the
// target itself.
func (t *Tool) extract(ctx context.Context, path string, o *ExtractOptions, x *extractor, counted func(int64)) error {
	if !t.Available() {
		return ErrNoTool
	}
	staging := fileops.PartialName(o.Dest, "extract-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	if err := os.Mkdir(staging, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	// Paths are absolute, so none starts with "-" ("--" would also stop
	// the list file from being read).
	args := []string{"x", "-y", "-bso0", "-bsp0", "-sccUTF-8", "-scsUTF-8", "-snl", "-o" + staging, path}
	if o.Include != nil && o.Selected != nil {
		list := filepath.Join(staging, ".list")
		var b strings.Builder
		for _, p := range o.Selected {
			fmt.Fprintf(&b, "%s\n%s/*\n", p, p)
		}
		if err := os.WriteFile(list, []byte(b.String()), 0o600); err != nil {
			return err
		}
		defer os.Remove(list)
		args = append(args, "@"+list)
	}
	cmd, stderr := t.command(ctx, args...)
	if err := toolError(ctx, cmd.Run(), stderr); err != nil {
		return err
	}
	if fi, err := os.Stat(path); err == nil && counted != nil {
		counted(fi.Size())
	}
	return walkStaged(ctx, staging, x)
}

// walkStaged feeds the staged tree to the extractor in path order.
func walkStaged(ctx context.Context, staging string, x *extractor) error {
	var paths []string
	err := filepath.WalkDir(staging, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == staging || (filepath.Dir(p) == staging && d.Name() == ".list") {
			return nil
		}
		paths = append(paths, p)
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(paths)
	for _, p := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		fi, err := os.Lstat(p)
		if err != nil {
			continue
		}
		rel, _ := filepath.Rel(staging, p)
		h := Header{Raw: filepath.ToSlash(rel), Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(), Mode: fi.Mode().Perm()}
		h.Path, h.Unsafe = CleanPath(h.Raw)
		var data io.Reader
		var f *os.File
		switch {
		case fi.IsDir():
			h.Kind, h.Size = KindDir, 0
		case fi.Mode()&fs.ModeSymlink != 0:
			h.Kind, h.Size = KindSymlink, 0
			h.Link, _ = os.Readlink(p)
			h.Link = filepath.ToSlash(h.Link)
		case fi.Mode().IsRegular():
			h.Kind = KindFile
			if f, err = os.Open(p); err != nil {
				x.o.fail(h.Raw, err)
				continue
			}
			data = f
		default:
			h.Kind, h.Size = KindSpecial, 0
		}
		err = x.entry(&h, data)
		if f != nil {
			_ = f.Close()
			_ = os.Remove(p) // staged bytes go as soon as they are placed
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// pack runs "7z a -t7z" from the items' folder with a list file of their
// names (links are stored as links, -snl).
func (t *Tool) pack(ctx context.Context, o *PackOptions, partial string) error {
	if len(o.Items) == 0 {
		return errors.New("archive: nothing to pack")
	}
	dir := filepath.Dir(o.Items[0].Path)
	list := partial + ".list"
	var b strings.Builder
	for _, it := range o.Items {
		if filepath.Dir(it.Path) != dir {
			return errors.New("archive: 7z packs entries of one folder")
		}
		b.WriteString(filepath.Base(it.Path))
		b.WriteByte('\n')
	}
	if err := os.WriteFile(list, []byte(b.String()), 0o600); err != nil {
		return err
	}
	defer os.Remove(list)
	cmd, stderr := t.command(ctx, "a", "-t7z", "-mx="+strconv.Itoa(o.Level), "-y", "-bso0", "-bsp0",
		"-sccUTF-8", "-scsUTF-8", "-snl", partial, "@"+list)
	cmd.Dir = dir
	return toolError(ctx, cmd.Run(), stderr)
}
