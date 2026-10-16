package git

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// Progress is a running operation's last report: Git's phase ("Receiving
// objects") and its percent, -1 when Git gives none.
type Progress struct {
	Phase   string
	Percent int
}

var progressRe = regexp.MustCompile(`^(?:remote: )?([A-Za-z][A-Za-z ]*[a-z]):\s+(\d{1,3})%`)

// progressLine tells Git's progress output from its messages.
func progressLine(l string) bool { return progressRe.MatchString(l) }

// run runs a command that changes the repository: stdin is `in`, progress
// lines go to onProgress as they come, and the answer is the last lines of
// what Git said (for the summary) or an Error.
func (t *Tool) run(ctx context.Context, dir string, in []byte, onProgress func(Progress), args ...string) (string, error) {
	if !t.Available() {
		return "", ErrNoGit
	}
	cmd := t.command(ctx, dir, args...)
	if in != nil {
		cmd.Stdin = bytes.NewReader(in)
	}
	var stdout limited
	stdout.n = maxStderr
	cmd.Stdout = &stdout
	pr, pw := io.Pipe()
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		return "", err
	}
	stderr := &limited{n: maxStderr}
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 4096), 64<<10)
		// Progress rewrites its line with \r; messages end with \n.
		sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
			if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
				return i + 1, data[:i], nil
			}
			if atEOF && len(data) > 0 {
				return len(data), data, nil
			}
			return 0, nil, nil
		})
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if m := progressRe.FindStringSubmatch(line); m != nil {
				if onProgress != nil {
					pct, _ := strconv.Atoi(m[2])
					onProgress(Progress{Phase: m[1], Percent: min(pct, 100)})
				}
				continue
			}
			if line != "" {
				stderr.WriteString(line)
				stderr.WriteByte('\n')
			}
		}
		// A line past the buffer stops the scan: the rest is drained unread.
		if sc.Err() != nil {
			_, _ = io.Copy(io.Discard, pr)
		}
	}()
	err := cmd.Wait()
	_ = pw.Close()
	<-done
	if err != nil {
		return "", runError(ctx, err, stderr.String())
	}
	return stdout.String() + "\n" + stderr.String(), nil
}

// headline is the first meaningful line Git printed: a commit's "[main
// 1a2b3c4] Subject".
func headline(out string) string {
	for l := range strings.SplitSeq(out, "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "hint:") {
			return l
		}
	}
	return ""
}

// summary is the last meaningful line Git printed.
func summary(out string) string {
	lines := strings.Split(out, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" && !strings.HasPrefix(l, "hint:") {
			return l
		}
	}
	return ""
}

// pathspecs is the NUL-separated pathspec file Git reads from stdin.
func pathspecs(paths []string) []byte {
	var b bytes.Buffer
	for _, p := range paths {
		b.WriteString(p)
		b.WriteByte(0)
	}
	return b.Bytes()
}

// Stage adds the paths (new, changed and deleted) to the index.
func (t *Tool) Stage(ctx context.Context, root string, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	_, err := t.run(ctx, root, pathspecs(paths), nil, "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul")
	return err
}

// StageAll adds every change of the working tree.
func (t *Tool) StageAll(ctx context.Context, root string) error {
	_, err := t.run(ctx, root, nil, nil, "add", "--all")
	return err
}

// Unstage takes the paths out of the index, back to HEAD (out of the index
// altogether before the first commit).
func (t *Tool) Unstage(ctx context.Context, root string, paths []string, unborn bool) error {
	if len(paths) == 0 {
		return nil
	}
	args := []string{"restore", "--staged", "--pathspec-from-file=-", "--pathspec-file-nul"}
	if unborn {
		args = []string{"rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"}
	}
	_, err := t.run(ctx, root, pathspecs(paths), nil, args...)
	return err
}

// Discarded is what a discard did: the paths restored from HEAD, and the
// untracked ones it left (it never deletes a file Git does not have).
type Discarded struct {
	Restored int
	Left     int
}

// Discard restores the entries' files from HEAD. New files only leave the
// index; untracked ones are left alone. Entries come from a status.
func (t *Tool) Discard(ctx context.Context, root string, entries []Entry, unborn bool) (Discarded, error) {
	var restore, unstage []string
	var d Discarded
	for _, e := range entries {
		path := strings.TrimSuffix(e.Path, "/")
		switch {
		case e.State == Untracked || e.State == Ignored:
			d.Left++
		case e.State == Added || unborn:
			unstage = append(unstage, path)
			d.Left++
		case e.State == Renamed:
			unstage = append(unstage, path)
			restore = append(restore, e.Orig)
			d.Left++
		default:
			restore = append(restore, path)
		}
	}
	if err := t.Unstage(ctx, root, unstage, unborn); err != nil {
		return d, err
	}
	if len(restore) > 0 {
		if _, err := t.run(ctx, root, pathspecs(restore), nil, "restore", "--source=HEAD", "--staged", "--worktree",
			"--pathspec-from-file=-", "--pathspec-file-nul"); err != nil {
			return d, err
		}
	}
	d.Restored = len(restore)
	return d, nil
}

// Commit records the index. An empty message with amend keeps the last
// commit's message.
func (t *Tool) Commit(ctx context.Context, root, message string, amend bool, onProgress func(Progress)) (string, error) {
	args := []string{"commit", "--cleanup=strip"}
	var in []byte
	if strings.TrimSpace(message) == "" {
		if !amend {
			return "", &Error{Message: "Write a commit message."}
		}
		args = append(args, "--amend", "--no-edit")
	} else {
		args = append(args, "-F", "-")
		in = []byte(message)
		if amend {
			args = append(args, "--amend")
		}
	}
	out, err := t.run(ctx, root, in, onProgress, args...)
	return headline(out), err
}

// PullMode is how a pull joins diverged histories: only fast-forward
// (the default, it never makes a merge the user did not ask for), rebase or merge.
type PullMode string

const (
	PullFastForward PullMode = "ffOnly"
	PullRebase      PullMode = "rebase"
	PullMerge       PullMode = "merge"
)

func (t *Tool) Pull(ctx context.Context, root string, mode PullMode, onProgress func(Progress)) (string, error) {
	flag := "--ff-only"
	switch mode {
	case PullRebase:
		flag = "--rebase"
	case PullMerge:
		flag = "--no-rebase"
	}
	out, err := t.run(ctx, root, nil, onProgress, "pull", "--progress", flag)
	return summary(out), err
}

// Push pushes the branch; the first push of a branch without an upstream
// sets one on the only remote (or "origin").
func (t *Tool) Push(ctx context.Context, root string, st *Status, onProgress func(Progress)) (string, error) {
	args := []string{"push", "--progress"}
	if st.Upstream == "" && st.Branch != "" {
		remote, err := t.pushRemote(ctx, root)
		if err != nil {
			return "", err
		}
		args = append(args, "--set-upstream", remote, "HEAD")
	}
	out, err := t.run(ctx, root, nil, onProgress, args...)
	return summary(out), err
}

func (t *Tool) pushRemote(ctx context.Context, root string) (string, error) {
	out, err := t.output(ctx, root, nil, "remote")
	if err != nil {
		return "", err
	}
	remotes := strings.Fields(string(out))
	switch {
	case len(remotes) == 0:
		return "", &Error{Message: "This repository has no remote to push to.", Reason: "noRemote"}
	case len(remotes) == 1:
		return remotes[0], nil
	}
	for _, r := range remotes {
		if r == "origin" {
			return r, nil
		}
	}
	return "", &Error{Message: "This branch has no upstream, and there is more than one remote.", Reason: "noUpstream"}
}

func (t *Tool) Fetch(ctx context.Context, root string, onProgress func(Progress)) (string, error) {
	out, err := t.run(ctx, root, nil, onProgress, "fetch", "--all", "--prune", "--progress")
	return summary(out), err
}

// Branch is a local or remote branch.
type Branch struct {
	Name     string `json:"name"`
	Remote   bool   `json:"remote"`
	Current  bool   `json:"current"`
	Upstream string `json:"upstream"`
	// Subject and When (Unix ms) of the branch's last commit.
	Subject string `json:"subject"`
	When    int64  `json:"when"`
}

// MaxBranches bounds the branch list.
const MaxBranches = 500

// Branches lists the local branches, then the remote ones, newest first.
func (t *Tool) Branches(ctx context.Context, root string) ([]Branch, bool, error) {
	out, err := t.output(ctx, root, nil, "for-each-ref", "--sort=-committerdate", "--count=2000",
		"--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(committerdate:unix)%00%(contents:subject)",
		"refs/heads", "refs/remotes")
	if err != nil {
		return nil, false, err
	}
	var local, remote []Branch
	for line := range strings.SplitSeq(string(out), "\n") {
		f := strings.SplitN(line, "\x00", 5)
		if len(f) != 5 {
			continue
		}
		when, _ := strconv.ParseInt(f[3], 10, 64)
		b := Branch{Current: f[1] == "*", Upstream: f[2], When: when * 1000, Subject: f[4]}
		if name, ok := strings.CutPrefix(f[0], "refs/heads/"); ok {
			b.Name = name
			local = append(local, b)
		} else if name, ok := strings.CutPrefix(f[0], "refs/remotes/"); ok && !strings.HasSuffix(name, "/HEAD") {
			b.Name, b.Remote = name, true
			remote = append(remote, b)
		}
	}
	all := append(local, remote...)
	truncated := len(all) > MaxBranches
	return all[:min(len(all), MaxBranches)], truncated, nil
}

// ErrBadName is a branch name Git would not take.
var ErrBadName = errors.New("not a valid branch name")

// CheckBranchName asks Git whether name can be a branch, and returns it as
// Git would write it.
func (t *Tool) CheckBranchName(ctx context.Context, root, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || strings.HasPrefix(name, "-") || len(name) > 250 {
		return "", ErrBadName
	}
	out, err := t.output(ctx, root, nil, "check-ref-format", "--branch", name)
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) {
			return "", ErrBadName
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// Switch checks out a branch from the list: a local one, or a remote one as a
// new local branch that tracks it (or its local branch, when there is one).
func (t *Tool) Switch(ctx context.Context, root string, b Branch, locals map[string]bool) (string, error) {
	if strings.HasPrefix(b.Name, "-") {
		return "", ErrBadName
	}
	args := []string{"switch", b.Name}
	if b.Remote {
		if _, short, ok := strings.Cut(b.Name, "/"); ok && locals[short] {
			args = []string{"switch", short}
		} else {
			args = []string{"switch", "--track", b.Name}
		}
	}
	out, err := t.run(ctx, root, nil, nil, args...)
	return summary(out), err
}

// CreateBranch makes a branch at HEAD and switches to it.
func (t *Tool) CreateBranch(ctx context.Context, root, name string) (string, error) {
	checked, err := t.CheckBranchName(ctx, root, name)
	if err != nil {
		return "", err
	}
	out, err := t.run(ctx, root, nil, nil, "switch", "-c", checked)
	return summary(out), err
}

// Commit is one commit of the log.
type LogEntry struct {
	Hash    string `json:"hash"`
	Author  string `json:"author"`
	When    int64  `json:"when"`
	Subject string `json:"subject"`
	// Refs are the branches and tags at this commit ("HEAD -> main, origin/main").
	Refs string `json:"refs"`
}

// MaxLog bounds a log.
const MaxLog = 100

// Log is the last commits of HEAD, newest first; empty before the first commit.
func (t *Tool) Log(ctx context.Context, root string, limit int) ([]LogEntry, error) {
	if limit <= 0 || limit > MaxLog {
		limit = MaxLog
	}
	out, err := t.output(ctx, root, nil, "log", "-n", strconv.Itoa(limit), "--no-color",
		"--format=%h%x00%an%x00%at%x00%D%x00%s%x1e")
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) && strings.Contains(strings.ToLower(ge.Message), "does not have any commits") {
			return nil, nil
		}
		return nil, err
	}
	var entries []LogEntry
	for rec := range strings.SplitSeq(string(out), "\x1e") {
		f := strings.SplitN(strings.TrimLeft(rec, "\n"), "\x00", 5)
		if len(f) != 5 {
			continue
		}
		when, _ := strconv.ParseInt(f[2], 10, 64)
		entries = append(entries, LogEntry{Hash: f[0], Author: f[1], When: when * 1000, Refs: f[3], Subject: f[4]})
	}
	return entries, nil
}

// Describe names an operation for logs.
func Describe(op string, n int) string {
	if n > 0 {
		return fmt.Sprintf("%s (%d paths)", op, n)
	}
	return op
}
