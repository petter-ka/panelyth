package compare

import (
	"cmp"
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/natsort"
)

// Row ids of compares come from their own range (ADR-0017), above the index
// ids and the archive entry ids, so a selection descriptor over a compare's
// session never names a file: an id is IDBase + compare<<rowBits + row + 1.
// All stay below 2^53.
const (
	IDBase  int64 = 3 << 51
	rowBits       = 20
	rowMask       = 1<<rowBits - 1
)

// MaxRows bounds one compare (memory: about 100 bytes per row). The walk
// stops there and the result says it is truncated.
const MaxRows = 500_000

// idLimit ends the range of compare rows: the entries of remote
// connections come above it (Stage C10.5, internal/remote).
const idLimit int64 = 7 << 50

// IsID reports whether id names a compare row.
func IsID(id int64) bool { return id >= IDBase && id < idLimit }

func rowID(compareID int64, row int) int64 {
	return IDBase + compareID<<rowBits + int64(row) + 1
}

// splitID returns the compare and the row an id names.
func splitID(id int64) (compareID int64, row int, ok bool) {
	if !IsID(id) {
		return 0, 0, false
	}
	v := id - IDBase
	row = int(v&rowMask) - 1
	return v >> rowBits, row, row >= 0
}

// Show selects the rows a compare's session lists, by the symbol of their
// action: →, ←, =, ≠ and ×. A sync applies the shown rows only, so nothing
// happens that the table does not show.
type Show uint8

const (
	ShowCopyRight Show = 1 << iota
	ShowCopyLeft
	ShowEqual
	ShowDifferent
	ShowDelete
	// ShowDefault hides the equal rows.
	ShowDefault = ShowCopyRight | ShowCopyLeft | ShowDifferent | ShowDelete
)

var showNames = map[string]Show{"copyRight": ShowCopyRight, "copyLeft": ShowCopyLeft, "equal": ShowEqual,
	"different": ShowDifferent, "delete": ShowDelete}

// ParseShow reads the wire form of a filter.
func ParseShow(names []string) (Show, bool) {
	var s Show
	for _, n := range names {
		bit, ok := showNames[n]
		if !ok {
			return 0, false
		}
		s |= bit
	}
	return s, true
}

const (
	flagLeft = 1 << iota
	flagRight
	flagDir
)

// row is one compared entry. A folder has a row only when it exists on one
// side (so empty folders are created and removed too); its files have rows
// of their own.
type row struct {
	dir            int32 // index into Result.dirs
	name           string
	lsize, rsize   int64
	lmtime, rmtime int64
	flags          uint8
	state          State
	action, def    Action
}

func (w *row) symbol() Show {
	switch w.action {
	case ActionCopyRight:
		return ShowCopyRight
	case ActionCopyLeft:
		return ShowCopyLeft
	case ActionDeleteRight, ActionDeleteLeft:
		return ShowDelete
	}
	if w.state == StateEqual {
		return ShowEqual
	}
	return ShowDifferent
}

// Spec describes a compare of two trees.
type Spec struct {
	// Left and Right are clean absolute folder paths.
	Left, Right string
	Options
	// Content also compares files of the same size byte by byte.
	Content bool
	// Asymmetric makes the right side a copy of the left (see defaultAction).
	Asymmetric bool
}

// ErrRunning is returned for changes and plans of a compare still running.
var ErrRunning = errors.New("compare: still running")

// ErrStalePlan is returned when a sync names an older plan than the current
// one: the table changed since the user confirmed it.
var ErrStalePlan = errors.New("compare: the plan changed")

// Result holds a compare's rows and serves its query session
// (query.Source and query.ItemSource).
type Result struct {
	id   int64
	spec Spec

	mu sync.RWMutex
	// dirs are the relative folders of the rows, "/"-separated; "" is the roots.
	dirs  []string
	rows  []row
	order []int32 // rows in display order; set when the walk has finished
	show  Show
	// plan changes with every change of the filter or of an action.
	plan      int64
	done      bool
	truncated bool
}

func newResult(id int64, spec Spec) *Result {
	return &Result{id: id, spec: spec, show: ShowDefault, plan: 1}
}

// ID is the compare's id.
func (r *Result) ID() int64 { return r.id }

// Len is the number of rows so far.
func (r *Result) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.rows)
}

// add appends the rows of one folder; false once the result is full.
func (r *Result) add(rel string, rows []row) bool {
	if len(rows) == 0 {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	room := MaxRows - len(r.rows)
	if room <= 0 {
		r.truncated = true
		return false
	}
	if len(rows) > room {
		rows, r.truncated = rows[:room], true
	}
	dir := int32(len(r.dirs))
	r.dirs = append(r.dirs, rel)
	for i := range rows {
		rows[i].dir = dir
	}
	r.rows = append(r.rows, rows...)
	return !r.truncated
}

// dirKey is a folder's sort key: natural order component by component, so a
// folder's own rows come before those of its subfolders.
func dirKey(rel string) string {
	if rel == "" {
		return ""
	}
	parts := strings.Split(rel, "/")
	for i, p := range parts {
		parts[i] = natsort.Key(p)
	}
	return strings.Join(parts, "\x00")
}

// arrange fixes the display order: by folder, then by natural name.
func (r *Result) arrange() {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys := make([]string, len(r.dirs))
	for i, d := range r.dirs {
		keys[i] = dirKey(d)
	}
	byKey := make([]int32, len(r.dirs))
	for i := range byKey {
		byKey[i] = int32(i)
	}
	slices.SortFunc(byKey, func(a, b int32) int { return strings.Compare(keys[a], keys[b]) })
	rank := make([]int32, len(r.dirs))
	for pos, d := range byKey {
		rank[d] = int32(pos)
	}
	nat := make([]string, len(r.rows))
	for i := range r.rows {
		nat[i] = natsort.Key(r.rows[i].name)
	}
	order := make([]int32, len(r.rows))
	for i := range order {
		order[i] = int32(i)
	}
	slices.SortFunc(order, func(a, b int32) int {
		ra, rb := &r.rows[a], &r.rows[b]
		return cmp.Or(cmp.Compare(rank[ra.dir], rank[rb.dir]), strings.Compare(nat[a], nat[b]),
			strings.Compare(ra.name, rb.name), cmp.Compare(a, b))
	})
	r.order = order
}

func (r *Result) finish() {
	r.mu.Lock()
	r.done = true
	r.plan++
	r.mu.Unlock()
}

// IDs implements query.Source: the shown rows in display order. The
// descriptor's sort and filters do not apply to a compare.
func (r *Result) IDs(context.Context, index.Descriptor) ([]int64, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]int64, 0, len(r.order))
	for _, i := range r.order {
		if r.rows[i].symbol()&r.show != 0 {
			ids = append(ids, rowID(r.id, int(i)))
		}
	}
	return ids, nil
}

// Names implements query.Source.
func (r *Result) Names(context.Context) (map[int64]index.NameRow, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[int64]index.NameRow, len(r.rows))
	for i := range r.rows {
		out[rowID(r.id, i)] = index.NameRow{Name: index.FoldName(r.rows[i].name), IsDir: r.rows[i].flags&flagDir != 0}
	}
	return out, nil
}

// Missing implements query.Source; a compare never loses rows.
func (r *Result) Missing() {}

// SingleFolder tells the query layer that rows carry no folder path of the
// index (theirs is relative, in Diff).
func (r *Result) SingleFolder() bool { return true }

func (r *Result) rowOf(id int64) (*row, bool) {
	cid, i, ok := splitID(id)
	if !ok || cid != r.id || i >= len(r.rows) {
		return nil, false
	}
	return &r.rows[i], true
}

// Items implements query.ItemSource: the row's name, and the size and date
// of the side that has it (the left one when both do).
func (r *Result) Items(_ context.Context, ids []int64) ([]index.Item, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]index.Item, 0, len(ids))
	for _, id := range ids {
		w, ok := r.rowOf(id)
		if !ok {
			continue
		}
		it := index.Item{ID: id, Name: w.name, Size: w.lsize, MtimeNs: w.lmtime, DirSize: -1}
		if w.flags&flagLeft == 0 {
			it.Size, it.MtimeNs = w.rsize, w.rmtime
		}
		switch {
		case w.flags&flagDir != 0:
			it.Kind, it.Size = media.KindDir, 0
		default:
			it.Kind, it.Ext = media.KindFile, media.Ext(w.name)
			if k, _, ok := media.Classify(w.name); ok {
				it.Kind = k
			}
		}
		out = append(out, it)
	}
	return out, nil
}

// Side is one side of a row; nil when the entry is not there.
type Side struct {
	Size    int64
	MtimeNs int64
}

// Diff is what a page row of a compare's session adds to its item.
type Diff struct {
	// Dir is the row's folder relative to the roots, "/"-separated.
	Dir         string
	State       State
	Action      Action
	Left, Right *Side
}

// Diffs returns the compare data of page rows by id.
func (r *Result) Diffs(ids []int64) map[int64]Diff {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[int64]Diff, len(ids))
	for _, id := range ids {
		w, ok := r.rowOf(id)
		if !ok {
			continue
		}
		d := Diff{Dir: r.dirs[w.dir], State: w.state, Action: w.action}
		if w.flags&flagLeft != 0 {
			d.Left = &Side{Size: w.lsize, MtimeNs: w.lmtime}
		}
		if w.flags&flagRight != 0 {
			d.Right = &Side{Size: w.rsize, MtimeNs: w.rmtime}
		}
		out[id] = d
	}
	return out
}

// SetShow changes the filter; the caller refreshes the session.
func (r *Result) SetShow(show Show) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.show != show {
		r.show = show
		r.plan++
	}
}

// SetAction gives rows a direction and returns how many changed. Rows the
// action does not apply to (a copy without its source, a delete of an entry
// that exists on both sides) keep theirs. Reset restores the defaults.
func (r *Result) SetAction(ids []int64, a Action, reset bool) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.done {
		return 0, ErrRunning
	}
	changed := 0
	for _, id := range ids {
		w, ok := r.rowOf(id)
		if !ok {
			continue
		}
		next := a
		if reset {
			next = w.def
		}
		if next != w.action && allowed(w.state, next) {
			w.action = next
			changed++
		}
	}
	if changed > 0 {
		r.plan++
	}
	return changed, nil
}

// Amount counts files and their bytes.
type Amount struct {
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

// Counts are the rows by symbol.
type Counts struct {
	CopyRight int `json:"copyRight"`
	CopyLeft  int `json:"copyLeft"`
	Equal     int `json:"equal"`
	Different int `json:"different"`
	Delete    int `json:"delete"`
}

// Summary says what a sync of the shown rows would do (the compare.plan
// result; mirrors src/shared/contracts ComparePlan).
type Summary struct {
	// Version names this plan; a sync job must be started with it.
	Version int64 `json:"version"`
	// Counts covers every row, shown or not.
	Counts      Counts `json:"counts"`
	CopyRight   Amount `json:"copyRight"`
	CopyLeft    Amount `json:"copyLeft"`
	DeleteRight int    `json:"deleteRight"`
	DeleteLeft  int    `json:"deleteLeft"`
	// Folders are the folders a sync creates.
	Folders int `json:"folders"`
	// OverwriteNewer are the copies that replace a newer file.
	OverwriteNewer int `json:"overwriteNewer"`
}

// Summary computes the current plan's summary.
func (r *Result) Summary() Summary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s := Summary{Version: r.plan}
	for i := range r.rows {
		w := &r.rows[i]
		sym := w.symbol()
		switch sym {
		case ShowCopyRight:
			s.Counts.CopyRight++
		case ShowCopyLeft:
			s.Counts.CopyLeft++
		case ShowEqual:
			s.Counts.Equal++
		case ShowDifferent:
			s.Counts.Different++
		case ShowDelete:
			s.Counts.Delete++
		}
		if sym&r.show == 0 {
			continue
		}
		isDir := w.flags&flagDir != 0
		switch w.action {
		case ActionCopyRight:
			if isDir {
				s.Folders++
				break
			}
			s.CopyRight.Files++
			s.CopyRight.Bytes += w.lsize
			if w.state == StateRightNewer {
				s.OverwriteNewer++
			}
		case ActionCopyLeft:
			if isDir {
				s.Folders++
				break
			}
			s.CopyLeft.Files++
			s.CopyLeft.Bytes += w.rsize
			if w.state == StateLeftNewer {
				s.OverwriteNewer++
			}
		case ActionDeleteRight:
			s.DeleteRight++
		case ActionDeleteLeft:
			s.DeleteLeft++
		}
	}
	return s
}

// PlanItem is one action of a sync, with the state of both sides as the
// compare saw them: a sync does nothing to an entry that changed since.
type PlanItem struct {
	// Rel is the entry's path below the roots, with OS separators.
	Rel         string
	IsDir       bool
	Action      Action
	Left, Right *Side
}

// Plan is what a sync job applies.
type Plan struct {
	Left, Right string
	// Items are in display order: a folder before what it holds.
	Items []PlanItem
}

// Plan returns the actions of the shown rows, when version is still the
// current plan and the compare has finished.
func (r *Result) Plan(version int64) (*Plan, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if !r.done {
		return nil, ErrRunning
	}
	if version != r.plan {
		return nil, ErrStalePlan
	}
	p := &Plan{Left: r.spec.Left, Right: r.spec.Right}
	for _, i := range r.order {
		w := &r.rows[i]
		if w.action == ActionNone || w.symbol()&r.show == 0 {
			continue
		}
		it := PlanItem{Rel: filepath.Join(filepath.FromSlash(r.dirs[w.dir]), w.name), IsDir: w.flags&flagDir != 0, Action: w.action}
		if w.flags&flagLeft != 0 {
			it.Left = &Side{Size: w.lsize, MtimeNs: w.lmtime}
		}
		if w.flags&flagRight != 0 {
			it.Right = &Side{Size: w.rsize, MtimeNs: w.rmtime}
		}
		p.Items = append(p.Items, it)
	}
	return p, nil
}
