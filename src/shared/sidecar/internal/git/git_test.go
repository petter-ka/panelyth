package git

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func status(lines ...string) []byte { return []byte(strings.Join(lines, "\x00") + "\x00") }

func TestParseStatus(t *testing.T) {
	s := ParseStatus(status(
		"# branch.oid 0123456789abcdef",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -1",
		"# stash 3",
		"1 .M N... 100644 100644 100644 aaa aaa src/app.go",
		"1 M. N... 100644 100644 100644 aaa bbb README.md",
		"1 A. N... 000000 100644 100644 000 bbb src/new file.go",
		"1 .D N... 100644 100644 000000 aaa aaa old.txt",
		"2 R. N... 100644 100644 100644 aaa aaa R100 docs/b.md", "docs/a.md",
		"u UU N... 100644 100644 100644 100644 a b c merge.txt",
		"? notes/",
		"? scratch.txt",
		"! node_modules/",
	))
	if s.Branch != "main" || s.Head != "0123456" || s.Upstream != "origin/main" || s.Ahead != 2 || s.Behind != 1 || s.Stashes != 3 {
		t.Fatalf("header: %+v", s)
	}
	want := []Entry{
		{Path: "src/app.go", State: Modified, Unstaged: true},
		{Path: "README.md", State: Modified, Staged: true},
		{Path: "src/new file.go", State: Added, Staged: true},
		{Path: "old.txt", State: Deleted, Unstaged: true},
		{Path: "docs/b.md", Orig: "docs/a.md", State: Renamed, Staged: true},
		{Path: "merge.txt", State: Conflicted, Unstaged: true},
		{Path: "notes/", State: Untracked, Unstaged: true},
		{Path: "scratch.txt", State: Untracked, Unstaged: true},
		{Path: "node_modules/", State: Ignored},
	}
	if len(s.Entries) != len(want) {
		t.Fatalf("entries: %+v", s.Entries)
	}
	for i, e := range want {
		if s.Entries[i] != e {
			t.Errorf("entry %d = %+v, want %+v", i, s.Entries[i], e)
		}
	}
	if c := s.Counts(); c != (Counts{Staged: 3, Changed: 2, Untracked: 2, Conflicted: 1}) {
		t.Errorf("counts = %+v", c)
	}
}

func TestParseStatusDetachedAndUnborn(t *testing.T) {
	s := ParseStatus(status("# branch.oid (initial)", "# branch.head main"))
	if !s.Unborn || s.Head != "" || s.Branch != "main" {
		t.Errorf("unborn: %+v", s)
	}
	s = ParseStatus(status("# branch.oid abcdef1234", "# branch.head (detached)"))
	if s.Branch != "" || s.Head != "abcdef1" {
		t.Errorf("detached: %+v", s)
	}
}

func marksOf(f Folder) map[string]Mark {
	out := map[string]Mark{}
	for _, m := range f.Marks {
		out[m.Name] = m
	}
	return out
}

func TestForFolder(t *testing.T) {
	s := ParseStatus(status(
		"1 .M N... 100644 100644 100644 a a src/app.go",
		"1 M. N... 100644 100644 100644 a b src/lib/util.go",
		"u UU N... 100644 100644 100644 100644 a b c src/lib/merge.go",
		"? src/lib/gen/",
		"1 A. N... 000000 100644 100644 0 b README.md",
		"? notes/",
		"! build/",
	))
	top := marksOf(s.ForFolder(""))
	if m := top["src"]; m.State != Conflicted || !m.Below || !m.Staged || !m.Unstaged {
		t.Errorf("src = %+v", m)
	}
	if m := top["README.md"]; m.State != Added || m.Below || !m.Staged {
		t.Errorf("README.md = %+v", m)
	}
	if m := top["notes"]; m.State != Untracked || m.Below {
		t.Errorf("notes = %+v", m)
	}
	if m := top["build"]; m.State != Ignored {
		t.Errorf("build = %+v", m)
	}
	lib := marksOf(s.ForFolder("src/lib"))
	if len(lib) != 3 || lib["util.go"].State != Modified || lib["merge.go"].State != Conflicted || lib["gen"].State != Untracked {
		t.Errorf("src/lib = %+v", lib)
	}
	// Inside a folder listed whole: everything shares its state.
	if f := s.ForFolder("src/lib/gen/deep"); f.Inherited != Untracked || len(f.Marks) != 0 {
		t.Errorf("inside untracked = %+v", f)
	}
	if f := s.ForFolder("build"); f.Inherited != Ignored {
		t.Errorf("inside ignored = %+v", f)
	}
	// A folder whose name starts like another's is not inside it.
	if f := s.ForFolder("sr"); len(f.Marks) != 0 || f.Inherited != "" {
		t.Errorf("sr = %+v", f)
	}
}

func TestForFolderCapsTheMarks(t *testing.T) {
	var lines []string
	for i := range MaxMarks + 10 {
		lines = append(lines, "? f"+strconv.Itoa(i))
	}
	f := ParseStatus(status(lines...)).ForFolder("")
	if len(f.Marks) != MaxMarks || !f.Truncated {
		t.Errorf("marks %d truncated %v", len(f.Marks), f.Truncated)
	}
}

func TestUnder(t *testing.T) {
	s := ParseStatus(status(
		"1 .M N... 100644 100644 100644 a a src/app.go",
		"1 .M N... 100644 100644 100644 a a srcx/b.go",
		"? src/gen/",
		"1 .M N... 100644 100644 100644 a a top.go",
	))
	paths := func(es []Entry) []string {
		var out []string
		for _, e := range es {
			out = append(out, e.Path)
		}
		return out
	}
	if got := strings.Join(paths(s.Under("src")), ","); got != "src/app.go,src/gen/" {
		t.Errorf("Under(src) = %s", got)
	}
	if got := strings.Join(paths(s.Under("src/gen/x.txt")), ","); got != "src/gen/" {
		t.Errorf("inside an untracked folder = %s", got)
	}
	if got := len(s.Under("")); got != 4 {
		t.Errorf("Under('') = %d", got)
	}
}

func TestMessageAndReason(t *testing.T) {
	stderr := "hint: something\nfatal: detected dubious ownership in repository at 'C:/x'\n"
	if m := message(stderr); m != "Detected dubious ownership in repository at 'C:/x'" {
		t.Errorf("message = %q", m)
	}
	if r := reasonOf(stderr); r != "unsafe" {
		t.Errorf("reason = %q", r)
	}
	if r := reasonOf("fatal: Not possible to fast-forward, aborting."); r != "diverged" {
		t.Errorf("reason = %q", r)
	}
	if !progressLine("remote: Counting objects:  45% (9/20)") || !progressLine("Receiving objects: 100% (20/20), done.") {
		t.Error("progress lines")
	}
	if progressLine("Already up to date.") {
		t.Error("a message is not progress")
	}
}

func TestFindRepo(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "repo", ".git", "refs"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "repo", ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
	deep := filepath.Join(root, "repo", "a", "b")
	_ = os.MkdirAll(deep, 0o755)
	r, ok := FindRepo(deep)
	if !ok || r.Root != filepath.Join(root, "repo") {
		t.Fatalf("FindRepo = %+v %v", r, ok)
	}
	if rel, ok := r.Rel(deep); !ok || rel != "a/b" {
		t.Errorf("Rel = %q %v", rel, ok)
	}
	if _, ok := FindRepo(filepath.Join(root, "repo", ".git", "refs")); ok {
		t.Error("the Git folder itself is not in a working tree")
	}
	if _, ok := FindRepo(root); ok {
		t.Error("outside the repository")
	}
	// A worktree's ".git" file.
	wt := filepath.Join(root, "wt")
	_ = os.MkdirAll(wt, 0o755)
	_ = os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: ../repo/.git\n"), 0o644)
	if r, ok := FindRepo(wt); !ok || r.GitDir != filepath.Join(root, "repo", ".git") {
		t.Errorf("worktree = %+v %v", r, ok)
	}
	// MERGE_HEAD: a merge in progress.
	_ = os.WriteFile(filepath.Join(root, "repo", ".git", "MERGE_HEAD"), []byte("x"), 0o644)
	if op := (Repo{GitDir: filepath.Join(root, "repo", ".git")}).Operation(); op != "merging" {
		t.Errorf("operation = %q", op)
	}
}

// The tests below run the installed Git on a repository made for them.

func gitTool(t *testing.T) *Tool {
	t.Helper()
	tool := Locate(os.Getenv)
	if !tool.Available() {
		t.Skip("git is not installed")
	}
	return tool
}

func sh(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@example.com")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, path, text string) {
	t.Helper()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	sh(t, root, "init", "-q", "-b", "main")
	sh(t, root, "config", "user.name", "T")
	sh(t, root, "config", "user.email", "t@example.com")
	sh(t, root, "config", "commit.gpgsign", "false")
	write(t, filepath.Join(root, "a.txt"), "one\n")
	write(t, filepath.Join(root, "src", "b.txt"), "two\n")
	write(t, filepath.Join(root, ".gitignore"), "build/\n")
	sh(t, root, "add", "-A")
	sh(t, root, "commit", "-q", "-m", "first")
	return root
}

func TestStatusStageCommitDiscard(t *testing.T) {
	tool := gitTool(t)
	ctx := context.Background()
	root := newRepo(t)
	write(t, filepath.Join(root, "a.txt"), "changed\n")
	write(t, filepath.Join(root, "src", "[c] d.txt"), "new\n")
	write(t, filepath.Join(root, "build", "out.bin"), "x")

	st, err := tool.ReadStatus(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if st.Branch != "main" || st.Unborn {
		t.Errorf("branch: %+v", st)
	}
	top := marksOf(st.ForFolder(""))
	if top["a.txt"].State != Modified || top["src"].State != Untracked || !top["src"].Below || top["build"].State != Ignored {
		t.Errorf("top marks = %+v", top)
	}

	// A name with [ ] is that name, not a pattern.
	if err := tool.Stage(ctx, root, []string{"src/[c] d.txt"}); err != nil {
		t.Fatal(err)
	}
	st, _ = tool.ReadStatus(ctx, root)
	if m := marksOf(st.ForFolder("src"))["[c] d.txt"]; m.State != Added || !m.Staged {
		t.Errorf("staged = %+v", m)
	}
	if err := tool.Unstage(ctx, root, []string{"src/[c] d.txt"}, false); err != nil {
		t.Fatal(err)
	}
	st, _ = tool.ReadStatus(ctx, root)
	if m := marksOf(st.ForFolder("src"))["[c] d.txt"]; m.State != Untracked {
		t.Errorf("unstaged = %+v", m)
	}

	// Discard restores a.txt and leaves the untracked file.
	d, err := tool.Discard(ctx, root, st.Under(""), false)
	if err != nil {
		t.Fatal(err)
	}
	if d.Restored != 1 || d.Left < 1 {
		t.Errorf("discarded = %+v", d)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "a.txt")); strings.ReplaceAll(string(b), "\r", "") != "one\n" {
		t.Errorf("a.txt = %q", b)
	}
	if _, err := os.Stat(filepath.Join(root, "src", "[c] d.txt")); err != nil {
		t.Error("discard deleted an untracked file")
	}

	if err := tool.Stage(ctx, root, []string{"src"}); err != nil {
		t.Fatal(err)
	}
	msg, err := tool.Commit(ctx, root, "Add c\n\nBody", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(msg, "[main ") || !strings.HasSuffix(msg, "] Add c") {
		t.Errorf("commit summary = %q", msg)
	}
	log, err := tool.Log(ctx, root, 10)
	if err != nil || len(log) != 2 || log[0].Subject != "Add c" || !strings.Contains(log[0].Refs, "main") {
		t.Errorf("log = %+v %v", log, err)
	}
	if _, err := tool.Commit(ctx, root, "  ", false, nil); err == nil {
		t.Error("an empty message commits")
	}
}

func TestBranches(t *testing.T) {
	tool := gitTool(t)
	ctx := context.Background()
	root := newRepo(t)
	if _, err := tool.CreateBranch(ctx, root, "feature/x"); err != nil {
		t.Fatal(err)
	}
	if _, err := tool.CreateBranch(ctx, root, "bad..name"); !errors.Is(err, ErrBadName) {
		t.Errorf("bad name: %v", err)
	}
	if _, err := tool.CreateBranch(ctx, root, "-f"); !errors.Is(err, ErrBadName) {
		t.Errorf("option as a name: %v", err)
	}
	branches, _, err := tool.Branches(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	current := ""
	for _, b := range branches {
		if b.Current {
			current = b.Name
		}
	}
	if current != "feature/x" || len(branches) != 2 {
		t.Errorf("branches = %+v", branches)
	}
	if _, err := tool.Switch(ctx, root, Branch{Name: "main"}, nil); err != nil {
		t.Fatal(err)
	}
	st, _ := tool.ReadStatus(ctx, root)
	if st.Branch != "main" {
		t.Errorf("switched to %q", st.Branch)
	}
}

func TestPushAndPullWithARemote(t *testing.T) {
	tool := gitTool(t)
	ctx := context.Background()
	remote := t.TempDir()
	sh(t, remote, "init", "-q", "--bare", "-b", "main")
	root := newRepo(t)
	sh(t, root, "remote", "add", "origin", remote)
	st, _ := tool.ReadStatus(ctx, root)
	// The first push sets the upstream.
	if _, err := tool.Push(ctx, root, st, nil); err != nil {
		t.Fatal(err)
	}
	st, _ = tool.ReadStatus(ctx, root)
	if st.Upstream != "origin/main" || st.Ahead != 0 {
		t.Errorf("after push: %+v", st)
	}
	// Another clone pushes; pull fast-forwards.
	other := t.TempDir()
	sh(t, other, "clone", "-q", remote, ".")
	sh(t, other, "config", "user.name", "T")
	sh(t, other, "config", "user.email", "t@example.com")
	write(t, filepath.Join(other, "z.txt"), "z\n")
	sh(t, other, "add", "z.txt")
	sh(t, other, "commit", "-q", "-m", "z")
	sh(t, other, "push", "-q")
	if _, err := tool.Fetch(ctx, root, nil); err != nil {
		t.Fatal(err)
	}
	st, _ = tool.ReadStatus(ctx, root)
	if st.Behind != 1 {
		t.Errorf("behind = %d", st.Behind)
	}
	if _, err := tool.Pull(ctx, root, PullFastForward, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "z.txt")); err != nil {
		t.Error("pull did not bring z.txt")
	}
}

func TestManagerRunsReportAndShareStatus(t *testing.T) {
	tool := gitTool(t)
	root := newRepo(t)
	var mu sync.Mutex
	var reports []Report
	done := make(chan Report, 4)
	m := NewManager(tool, slog.New(slog.NewTextHandler(io.Discard, nil)), func(r Report) {
		mu.Lock()
		reports = append(reports, r)
		mu.Unlock()
		if r.State != "running" {
			done <- r
		}
	})
	defer m.Close()
	ctx := context.Background()

	// Two asks at once share one read.
	var wg sync.WaitGroup
	results := make([]*Status, 2)
	for i := range 2 {
		wg.Go(func() { results[i], _ = m.Status(ctx, root, false) })
	}
	wg.Wait()
	if results[0] == nil || results[0] != results[1] {
		t.Error("concurrent asks did not share one status")
	}

	write(t, filepath.Join(root, "a.txt"), "two\n")
	id, err := m.Start(root, Request{Op: OpCommit, Message: "second", StageAll: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start(root, Request{Op: OpFetch}); !errors.Is(err, ErrBusy) {
		t.Errorf("a second run in the same repository: %v", err)
	}
	select {
	case r := <-done:
		if r.OpID != id || r.State != "completed" {
			t.Errorf("report = %+v", r)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the commit did not finish")
	}
	// The run dropped the cached status.
	st, _ := m.Status(ctx, root, false)
	if st == results[0] || len(st.Entries) != 0 {
		t.Errorf("status after the commit: %+v", st)
	}

	// A failed run says why.
	if _, err := m.Start(root, Request{Op: OpPush}); err != nil {
		t.Fatal(err)
	}
	r := <-done
	if r.State != "failed" || r.Reason != "noRemote" {
		t.Errorf("push without a remote = %+v", r)
	}

	// Change lists are named by index.
	id = m.SaveChanges(root, []Entry{{Path: "a"}, {Path: "b"}})
	if es, err := m.Changes(id, root, []int{1}); err != nil || es[0].Path != "b" {
		t.Errorf("changes = %+v %v", es, err)
	}
	if _, err := m.Changes(id, root, []int{2}); !errors.Is(err, ErrStaleChanges) {
		t.Errorf("out of range: %v", err)
	}
}
