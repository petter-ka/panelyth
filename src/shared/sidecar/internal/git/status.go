package git

import (
	"bytes"
	"context"
	"strconv"
	"strings"
)

// State is what Git says of a path, as the commander shows it.
type State string

const (
	Conflicted State = "conflicted"
	Modified   State = "modified"
	Deleted    State = "deleted"
	Added      State = "added"
	Renamed    State = "renamed"
	Untracked  State = "untracked"
	Ignored    State = "ignored"
)

// weight orders states for a folder: it shows the one that needs the most
// attention among those below it.
var weight = map[State]int{Conflicted: 7, Modified: 6, Deleted: 5, Added: 4, Renamed: 3, Untracked: 2, Ignored: 1}

// Entry is one line of `git status --porcelain=v2`.
type Entry struct {
	// Path is relative to the working tree, with forward slashes; a folder
	// listed whole (untracked or ignored) ends in "/".
	Path string
	// Orig is the path a rename came from.
	Orig  string
	State State
	// Staged: the index differs from HEAD; Unstaged: the working tree
	// differs from the index (or the path is untracked or conflicted).
	Staged, Unstaged bool
}

// Status is a repository's whole status.
type Status struct {
	// Branch is "" when HEAD is detached; Head the commit (short), "" before
	// the first commit (Unborn).
	Branch   string
	Head     string
	Unborn   bool
	Upstream string
	Ahead    int
	Behind   int
	Stashes  int
	Entries  []Entry
}

// Counts are a status's totals, as the Git bar shows them.
type Counts struct {
	Staged     int `json:"staged"`
	Changed    int `json:"changed"`
	Untracked  int `json:"untracked"`
	Conflicted int `json:"conflicted"`
}

// Counts totals the entries; ignored paths are not counted.
func (s *Status) Counts() Counts {
	var c Counts
	for _, e := range s.Entries {
		switch e.State {
		case Ignored:
		case Untracked:
			c.Untracked++
		case Conflicted:
			c.Conflicted++
		default:
			if e.Staged {
				c.Staged++
			}
			if e.Unstaged {
				c.Changed++
			}
		}
	}
	return c
}

// ReadStatus runs `git status` in the working tree.
func (t *Tool) ReadStatus(ctx context.Context, root string) (*Status, error) {
	out, err := t.output(ctx, root, nil, "--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch",
		"--show-stash", "--untracked-files=normal", "--ignored=matching")
	if err != nil {
		return nil, err
	}
	return ParseStatus(out), nil
}

// ParseStatus reads `git status --porcelain=v2 -z --branch --show-stash`.
// Lines it does not know are skipped.
func ParseStatus(out []byte) *Status {
	s := &Status{}
	recs := bytes.Split(out, []byte{0})
	for i := 0; i < len(recs); i++ {
		rec := string(recs[i])
		if len(rec) < 2 {
			continue
		}
		switch rec[0] {
		case '#':
			s.header(rec[2:])
		case '1':
			if f := strings.SplitN(rec, " ", 9); len(f) == 9 {
				s.Entries = append(s.Entries, changed(f[1], f[8], ""))
			}
		case '2':
			// The path a rename came from is the next record.
			if f := strings.SplitN(rec, " ", 10); len(f) == 10 {
				orig := ""
				if i+1 < len(recs) {
					i++
					orig = string(recs[i])
				}
				s.Entries = append(s.Entries, changed(f[1], f[9], orig))
			}
		case 'u':
			if f := strings.SplitN(rec, " ", 11); len(f) == 11 {
				s.Entries = append(s.Entries, Entry{Path: f[10], State: Conflicted, Unstaged: true})
			}
		case '?':
			s.Entries = append(s.Entries, Entry{Path: rec[2:], State: Untracked, Unstaged: true})
		case '!':
			s.Entries = append(s.Entries, Entry{Path: rec[2:], State: Ignored})
		}
	}
	return s
}

func (s *Status) header(h string) {
	key, value, _ := strings.Cut(h, " ")
	switch key {
	case "branch.oid":
		if value == "(initial)" {
			s.Unborn = true
		} else {
			s.Head = value[:min(len(value), 7)]
		}
	case "branch.head":
		if value != "(detached)" {
			s.Branch = value
		}
	case "branch.upstream":
		s.Upstream = value
	case "branch.ab":
		a, b, _ := strings.Cut(value, " ")
		s.Ahead, _ = strconv.Atoi(strings.TrimPrefix(a, "+"))
		s.Behind, _ = strconv.Atoi(strings.TrimPrefix(b, "-"))
	case "stash":
		s.Stashes, _ = strconv.Atoi(value)
	}
}

// changed reads a changed or renamed entry's XY.
func changed(xy, path, orig string) Entry {
	x, y := byte('.'), byte('.')
	if len(xy) == 2 {
		x, y = xy[0], xy[1]
	}
	e := Entry{Path: path, Orig: orig, Staged: x != '.', Unstaged: y != '.'}
	switch {
	case x == 'D' || y == 'D':
		e.State = Deleted
	case x == 'A' || x == 'C':
		e.State = Added
	case x == 'R':
		e.State = Renamed
	default:
		e.State = Modified
	}
	return e
}

// Mark is the status of one child of a folder.
type Mark struct {
	Name     string `json:"name"`
	State    State  `json:"state"`
	Staged   bool   `json:"staged"`
	Unstaged bool   `json:"unstaged"`
	// Below: a folder whose status comes from what is inside it.
	Below bool `json:"below"`
}

// Folder is the part of a status a folder's panel shows.
type Folder struct {
	Marks []Mark
	// Inherited: the whole folder is untracked or ignored, so is everything
	// in it; Marks is then empty.
	Inherited State
	Truncated bool
}

// MaxMarks bounds the marks of one folder.
const MaxMarks = 5000

// ForFolder picks the marks of the children of rel ("" for the top folder,
// forward slashes): a file's own status, a folder's strongest status below.
func (s *Status) ForFolder(rel string) Folder {
	prefix := ""
	if rel != "" {
		prefix = rel + "/"
	}
	var f Folder
	byName := map[string]int{}
	for _, e := range s.Entries {
		// A folder listed whole that holds this folder: everything in it shares its state.
		if strings.HasSuffix(e.Path, "/") && prefix != "" && strings.HasPrefix(prefix, e.Path) {
			if weight[e.State] > weight[f.Inherited] {
				f.Inherited = e.State
			}
			continue
		}
		rest, ok := strings.CutPrefix(e.Path, prefix)
		if !ok || rest == "" {
			continue
		}
		name, deeper, _ := strings.Cut(rest, "/")
		// "sub/" is the folder sub listed whole; "sub/x" something below it.
		below := deeper != ""
		if i, seen := byName[name]; seen {
			m := &f.Marks[i]
			if weight[e.State] > weight[m.State] {
				m.State = e.State
			}
			m.Staged = m.Staged || e.Staged
			m.Unstaged = m.Unstaged || e.Unstaged
			m.Below = m.Below || below
			continue
		}
		if len(f.Marks) >= MaxMarks {
			f.Truncated = true
			continue
		}
		byName[name] = len(f.Marks)
		f.Marks = append(f.Marks, Mark{Name: name, State: e.State, Staged: e.Staged, Unstaged: e.Unstaged, Below: below})
	}
	if f.Inherited != "" {
		f.Marks = nil
	}
	return f
}

// Under is the entries at path p or below it ("" is every entry), the way
// an operation on a folder reaches what is inside.
func (s *Status) Under(p string) []Entry {
	var out []Entry
	for _, e := range s.Entries {
		path := strings.TrimSuffix(e.Path, "/")
		if p == "" || path == p || strings.HasPrefix(path, p+"/") || strings.HasPrefix(p+"/", e.Path) && strings.HasSuffix(e.Path, "/") {
			out = append(out, e)
		}
	}
	return out
}
