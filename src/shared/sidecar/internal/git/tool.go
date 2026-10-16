// Package git runs the installed Git for the commander (ADR-0043): the status
// of a folder's repository, and the basic operations in the background.
package git

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"panelyth/sidecar/internal/platform"
)

// Tool is the Git executable. The zero value and nil are "unavailable":
// the commander then shows no Git UI.
type Tool struct {
	Path string
}

// Locate finds Git: PANELYTH_GIT (a path; "off" disables it), then PATH and
// the folders Git for Windows installs to.
func Locate(getenv func(string) string) *Tool {
	return locate(platform.HostTools(getenv))
}

func locate(f platform.ToolFinder) *Tool {
	if v := f.Getenv("PANELYTH_GIT"); v != "" {
		if v == "off" {
			return &Tool{}
		}
		return &Tool{Path: f.File(v)}
	}
	return &Tool{Path: f.Installed([]string{"git"}, `Git\cmd`, `Git\bin`)}
}

// Available reports whether Git was found.
func (t *Tool) Available() bool { return t != nil && t.Path != "" }

// maxStderr bounds what is kept of Git's error output; maxOutput what a read
// may return (a status of a huge change set fails instead of filling memory).
const (
	maxStderr = 64 << 10
	maxOutput = 64 << 20
)

// ErrNoGit is returned when Git was not found.
var ErrNoGit = errors.New("git was not found")

// ErrTooLarge is a read whose output passed maxOutput.
var ErrTooLarge = errors.New("git's answer is too large")

// command builds a Git run in dir: no console window, no prompt for a
// password on a terminal, English messages (progress lines are parsed), and
// paths taken literally (a name with * is that name).
func (t *Tool) command(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, t.Path, append([]string{"-c", "core.quotepath=off", "-c", "color.ui=false"}, args...)...)
	cmd.Dir = dir
	hideWindow(cmd)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_LITERAL_PATHSPECS=1",
		"GIT_OPTIONAL_LOCKS=0",
		"LC_ALL=C",
		"LANGUAGE=en",
		// An editor is never opened: a commit's message comes on stdin.
		"GIT_EDITOR=true",
		"GIT_MERGE_AUTOEDIT=no",
	)
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

// Error is a failed Git run: its exit code and the first useful line of
// what it said.
type Error struct {
	Code    int
	Message string
	// Reason classifies a few failures the commander explains: "unsafe"
	// (a repository owned by another user), "auth", "diverged", "conflict",
	// "dirty" (local changes in the way), "noUpstream", "noRemote".
	Reason string
}

func (e *Error) Error() string { return e.Message }

// output runs a read: stdout, bounded; stdin is empty or `in`.
func (t *Tool) output(ctx context.Context, dir string, in []byte, args ...string) ([]byte, error) {
	if !t.Available() {
		return nil, ErrNoGit
	}
	cmd := t.command(ctx, dir, args...)
	if in != nil {
		cmd.Stdin = bytes.NewReader(in)
	}
	var stdout limited
	stdout.n = maxOutput
	stderr := &limited{n: maxStderr}
	cmd.Stdout, cmd.Stderr = &stdout, stderr
	err := cmd.Run()
	if stdout.over {
		return nil, ErrTooLarge
	}
	if err != nil {
		return nil, runError(ctx, err, stderr.String())
	}
	return stdout.Bytes(), nil
}

// limited keeps the first n bytes written to it.
type limited struct {
	bytes.Buffer
	n    int
	over bool
}

func (l *limited) Write(p []byte) (int, error) {
	room := l.n - l.Len()
	if room < len(p) {
		l.over = true
		if room > 0 {
			l.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return l.Buffer.Write(p)
}

var _ io.Writer = (*limited)(nil)

// runError maps a failed run to an Error with Git's message.
func runError(ctx context.Context, err error, stderr string) error {
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return err
	}
	msg := message(stderr)
	if msg == "" {
		msg = "Git stopped with an error."
	}
	return &Error{Code: ee.ExitCode(), Message: msg, Reason: reasonOf(stderr)}
}

// message is the line of Git's output that says what went wrong: "fatal:"
// or "error:" lines first, without the prefix and hints.
func message(stderr string) string {
	lines := strings.FieldsFunc(stderr, func(r rune) bool { return r == '\n' || r == '\r' })
	first := ""
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "hint:") {
			continue
		}
		for _, p := range []string{"fatal: ", "error: "} {
			if rest, ok := strings.CutPrefix(l, p); ok {
				return upperFirst(rest)
			}
		}
		if first == "" && !progressLine(l) {
			first = l
		}
	}
	return upperFirst(first)
}

func upperFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func reasonOf(stderr string) string {
	low := strings.ToLower(stderr)
	switch {
	case strings.Contains(low, "dubious ownership"):
		return "unsafe"
	case strings.Contains(low, "authentication failed"), strings.Contains(low, "could not read username"),
		strings.Contains(low, "permission denied (publickey"), strings.Contains(low, "terminal prompts disabled"):
		return "auth"
	case strings.Contains(low, "not possible to fast-forward"), strings.Contains(low, "divergent branches"),
		strings.Contains(low, "updates were rejected"):
		return "diverged"
	case strings.Contains(low, "conflict"):
		return "conflict"
	case strings.Contains(low, "would be overwritten"), strings.Contains(low, "please commit your changes or stash them"):
		return "dirty"
	case strings.Contains(low, "has no upstream branch"), strings.Contains(low, "no tracking information"):
		return "noUpstream"
	case strings.Contains(low, "no configured push destination"), strings.Contains(low, "does not appear to be a git repository"):
		return "noRemote"
	}
	return ""
}
