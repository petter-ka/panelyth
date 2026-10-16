package app

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"panelyth/sidecar/internal/git"
	"panelyth/sidecar/internal/rpc"
)

// Git in the commander (ADR-0043) through the RPC handlers: a folder's
// status, runs on a panel's selection and on the commit dialog's change
// list, branches and the log.

type gitReports struct {
	mu   sync.Mutex
	done map[int64]git.Report
}

func (r *gitReports) wait(t *testing.T, opID int64) git.Report {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		rep, ok := r.done[opID]
		r.mu.Unlock()
		if ok {
			return rep
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("git run %d did not finish", opID)
	return git.Report{}
}

func newGitService(t *testing.T) (*indexService, *gitReports) {
	t.Helper()
	tool := git.Locate(os.Getenv)
	if !tool.Available() {
		t.Skip("git is not installed")
	}
	svc := newContextService(t, t.TempDir())
	reports := &gitReports{done: map[int64]git.Report{}}
	svc.git = git.NewManager(tool, slog.New(slog.DiscardHandler), func(r git.Report) {
		if r.State != "running" {
			reports.mu.Lock()
			reports.done[r.OpID] = r
			reports.mu.Unlock()
		}
	})
	return svc, reports
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func gitRepoFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	gitIn(t, root, "init", "-q", "-b", "main")
	gitIn(t, root, "config", "user.name", "T")
	gitIn(t, root, "config", "user.email", "t@example.com")
	gitIn(t, root, "config", "commit.gpgsign", "false")
	for p, text := range map[string]string{"a.txt": "a\n", "src/b.txt": "b\n", ".gitignore": "*.log\n"} {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755)
		_ = os.WriteFile(filepath.Join(root, p), []byte(text), 0o644)
	}
	gitIn(t, root, "add", "-A")
	gitIn(t, root, "commit", "-q", "-m", "first")
	return root
}

func marksByName(marks []git.Mark) map[string]git.Mark {
	out := map[string]git.Mark{}
	for _, m := range marks {
		out[m.Name] = m
	}
	return out
}

func TestGitStatusOfAFolder(t *testing.T) {
	ctx := context.Background()
	svc, _ := newGitService(t)
	root := gitRepoFixture(t)
	_ = os.WriteFile(filepath.Join(root, "a.txt"), []byte("changed\n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "src", "new.txt"), []byte("n\n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "debug.log"), []byte("x"), 0o644)
	dirID, _ := openListed(t, svc, root)

	res, err := svc.gitStatus(ctx, gitDirParams{DirID: dirID})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Available || res.Repo == nil || res.Repo.Branch != "main" || res.Repo.Rel != "" || res.Repo.Name != filepath.Base(root) {
		t.Fatalf("status = %+v", res)
	}
	if c := res.Repo.Counts; c.Changed != 1 || c.Untracked != 1 {
		t.Errorf("counts = %+v", c)
	}
	m := marksByName(res.Marks)
	if m["a.txt"].State != git.Modified || m["src"].State != git.Untracked || !m["src"].Below || m["debug.log"].State != git.Ignored {
		t.Errorf("marks = %+v", m)
	}

	sub, _ := openListed(t, svc, filepath.Join(root, "src"))
	res, _ = svc.gitStatus(ctx, gitDirParams{DirID: sub})
	if res.Repo == nil || res.Repo.Rel != "src" || marksByName(res.Marks)["new.txt"].State != git.Untracked {
		t.Errorf("src = %+v", res)
	}

	// A folder outside any repository: Git is there, the repository is not.
	outside, _ := openListed(t, svc, t.TempDir())
	res, _ = svc.gitStatus(ctx, gitDirParams{DirID: outside})
	if !res.Available || res.Repo != nil {
		t.Errorf("outside = %+v", res)
	}
	if _, err := svc.gitBranches(ctx, gitDirParams{DirID: outside}); err == nil {
		t.Error("branches outside a repository")
	}
}

func TestGitRunsOnTheSelectionAndTheChangeList(t *testing.T) {
	ctx := context.Background()
	svc, reports := newGitService(t)
	root := gitRepoFixture(t)
	_ = os.WriteFile(filepath.Join(root, "a.txt"), []byte("changed\n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "c.txt"), []byte("c\n"), 0o644)
	dirID, _ := openListed(t, svc, root)
	snap, _ := svc.queryOpen(ctx, queryOpenParams{DirID: dirID, Scope: "all", ShowHidden: true,
		Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	_, names := pageNames(t, svc, snap.QueryID)
	idx := slices.Index(names, "c.txt")
	sel := selectionWire{QueryID: snap.QueryID, Version: snap.Version, Ranges: [][2]int{{idx, idx + 1}}, Include: []int64{}, Exclude: []int64{}}

	// Stage c.txt from the panel's selection.
	run, err := svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpStage, Selection: &sel})
	if err != nil {
		t.Fatal(err)
	}
	if r := reports.wait(t, run.OpID); r.State != "completed" {
		t.Fatalf("stage = %+v", r)
	}
	res, _ := svc.gitStatus(ctx, gitDirParams{DirID: dirID})
	if m := marksByName(res.Marks)["c.txt"]; m.State != git.Added || !m.Staged {
		t.Errorf("c.txt = %+v", m)
	}

	// The commit dialog's list: stage a.txt by its row, then commit.
	changes, err := svc.gitChanges(ctx, gitDirParams{DirID: dirID})
	if err != nil {
		t.Fatal(err)
	}
	row := slices.IndexFunc(changes.Entries, func(c gitChangeWire) bool { return c.Path == "a.txt" })
	if row < 0 || len(changes.Entries) != 2 {
		t.Fatalf("changes = %+v", changes)
	}
	run, _ = svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpStage, ChangesID: changes.ChangesID, Items: []int{row}})
	reports.wait(t, run.OpID)
	run, _ = svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpCommit, Message: "Second"})
	if r := reports.wait(t, run.OpID); r.State != "completed" {
		t.Fatalf("commit = %+v", r)
	}
	log, err := svc.gitLog(ctx, gitLogParams{DirID: dirID, Limit: 5})
	if err != nil || len(log.Entries) != 2 || log.Entries[0].Subject != "Second" {
		t.Errorf("log = %+v %v", log, err)
	}
	res, _ = svc.gitStatus(ctx, gitDirParams{DirID: dirID})
	if len(res.Marks) != 0 || res.Repo.Counts != (git.Counts{}) {
		t.Errorf("after commit = %+v", res)
	}

	// A stale change list is refused.
	if _, err := svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpStage, ChangesID: changes.ChangesID + 100, Items: []int{0}}); err == nil {
		t.Error("an unknown change list was taken")
	}

	// Branches: create one, switch back; a bad name fails with a reason.
	run, _ = svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpCreateBranch, Branch: "topic"})
	reports.wait(t, run.OpID)
	br, _ := svc.gitBranches(ctx, gitDirParams{DirID: dirID})
	if len(br.Branches) != 2 || !slices.ContainsFunc(br.Branches, func(b git.Branch) bool { return b.Name == "topic" && b.Current }) {
		t.Errorf("branches = %+v", br)
	}
	run, _ = svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpSwitch, Branch: "main"})
	if r := reports.wait(t, run.OpID); r.State != "completed" {
		t.Errorf("switch = %+v", r)
	}
	run, _ = svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpCreateBranch, Branch: "a..b"})
	if r := reports.wait(t, run.OpID); r.State != "failed" || r.Reason != "badName" {
		t.Errorf("bad name = %+v", r)
	}
	if _, err := svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpSwitch, Branch: "--force"}); err == nil {
		t.Error("an option as a branch name was taken")
	}
	if _, err := svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: "rm -rf"}); err == nil {
		t.Error("an unknown operation was taken")
	}
}

func TestGitUnavailable(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	svc.git = git.NewManager(&git.Tool{}, slog.New(slog.DiscardHandler), func(git.Report) {})
	root := gitRepoFixtureOrSkip(t)
	dirID, _ := openListed(t, svc, root)
	res, err := svc.gitStatus(ctx, gitDirParams{DirID: dirID})
	if err != nil || res.Available || res.Repo != nil {
		t.Errorf("status without Git = %+v %v", res, err)
	}
	_, err = svc.gitRun(ctx, gitRunParams{DirID: dirID, Op: git.OpFetch})
	if code, _ := rpcReason(err); code != rpc.CodeUnsupportedMedia {
		t.Errorf("run without Git: %v", err)
	}
}

// gitRepoFixtureOrSkip is a folder that looks like a repository to FindRepo.
func gitRepoFixtureOrSkip(t *testing.T) string {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, ".git"), 0o755)
	_ = os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
	return root
}
