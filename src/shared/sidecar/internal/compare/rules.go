// Package compare answers "what's different between these two places?"
// (Stage C08): the flat compare behind Shift+F2, the recursive compare of
// two trees that a synchronize dialog shows as a query session (ADR-0017),
// the plan a sync job applies, and streamed file equality.
package compare

import "time"

// Options are the date rules of a compare. File systems keep dates at
// different resolutions (FAT: 2 s) and some shift them by an hour with
// daylight saving time, so both are explicit options.
type Options struct {
	// Tolerance: dates this close are the same (0 = exact).
	Tolerance time.Duration
	// DST: dates exactly one hour apart (within the tolerance) are the same.
	DST bool
	// IgnoreDates compares by name and size (and content) only.
	IgnoreDates bool
}

// cmpTime returns 1 when a is newer than b, -1 when older, 0 when the dates
// are the same by the rules.
func (o Options) cmpTime(a, b int64) int {
	if o.IgnoreDates {
		return 0
	}
	d := a - b
	if d < 0 {
		d = -d
	}
	tol := int64(o.Tolerance)
	if d <= tol {
		return 0
	}
	if h := d - int64(time.Hour); o.DST && h <= tol && h >= -tol {
		return 0
	}
	if a > b {
		return 1
	}
	return -1
}

// State is how the two sides of a row relate.
type State uint8

const (
	// StateEqual: on both sides and the same by the rules.
	StateEqual State = iota
	StateLeftNewer
	StateRightNewer
	// StateDifferent: on both sides with the same date (or dates ignored)
	// but another size or content.
	StateDifferent
	StateLeftOnly
	StateRightOnly
	// StateMismatch: a file on one side, a folder on the other.
	StateMismatch
)

var stateNames = [...]string{"equal", "leftNewer", "rightNewer", "different", "leftOnly", "rightOnly", "mismatch"}

func (s State) String() string { return stateNames[s] }

// classify compares two files by size and date.
func (o Options) classify(lsize, lmtime, rsize, rmtime int64) State {
	switch c := o.cmpTime(lmtime, rmtime); {
	case c > 0:
		return StateLeftNewer
	case c < 0:
		return StateRightNewer
	case lsize != rsize:
		return StateDifferent
	}
	return StateEqual
}

// Action is what a sync does with a row.
type Action uint8

const (
	// ActionNone leaves both sides alone ("=" for equal rows, "≠" otherwise).
	ActionNone Action = iota
	// ActionCopyRight copies left to right ("→").
	ActionCopyRight
	// ActionCopyLeft copies right to left ("←").
	ActionCopyLeft
	// ActionDeleteRight and ActionDeleteLeft delete a one-sided entry ("×").
	ActionDeleteRight
	ActionDeleteLeft
)

var actionNames = [...]string{"none", "copyRight", "copyLeft", "deleteRight", "deleteLeft"}

func (a Action) String() string { return actionNames[a] }

// ParseAction reads an action's wire name.
func ParseAction(s string) (Action, bool) {
	for i, n := range actionNames {
		if n == s {
			return Action(i), true
		}
	}
	return ActionNone, false
}

// defaultAction is the direction a row starts with. Symmetric: the newer
// file wins and one-sided entries are copied across. Asymmetric (left to
// right only): the right side becomes the left side, so files that exist
// only on the right are deleted there.
func defaultAction(s State, asymmetric bool) Action {
	switch s {
	case StateLeftNewer, StateLeftOnly:
		return ActionCopyRight
	case StateRightNewer:
		if asymmetric {
			return ActionCopyRight
		}
		return ActionCopyLeft
	case StateDifferent:
		if asymmetric {
			return ActionCopyRight
		}
	case StateRightOnly:
		if asymmetric {
			return ActionDeleteRight
		}
		return ActionCopyLeft
	}
	return ActionNone
}

// allowed reports whether a row in state s may get action a: copies need
// their source, deletes only ever apply to one-sided entries, and a file
// never replaces a folder.
func allowed(s State, a Action) bool {
	switch a {
	case ActionNone:
		return true
	case ActionCopyRight:
		return s != StateRightOnly && s != StateMismatch
	case ActionCopyLeft:
		return s != StateLeftOnly && s != StateMismatch
	case ActionDeleteRight:
		return s == StateRightOnly
	case ActionDeleteLeft:
		return s == StateLeftOnly
	}
	return false
}

// Entry is one side's entry in a flat compare.
type Entry struct {
	// Key is the name as the file system compares it (pathkey fold).
	Key     string
	IsDir   bool
	Size    int64
	MtimeNs int64
}

// Marks is the flat compare behind Shift+F2: it reports, per side, the files
// that are unique or newer there. Two files of the same date and different
// sizes are both marked. Folders are never marked or matched.
func Marks(left, right []Entry, o Options) (l, r []bool) {
	l, r = make([]bool, len(left)), make([]bool, len(right))
	byKey := make(map[string]int, len(right))
	for i, e := range right {
		if !e.IsDir {
			byKey[e.Key] = i
		}
	}
	matched := make([]bool, len(right))
	for i, e := range left {
		if e.IsDir {
			continue
		}
		j, ok := byKey[e.Key]
		if !ok {
			l[i] = true
			continue
		}
		matched[j] = true
		switch o.classify(e.Size, e.MtimeNs, right[j].Size, right[j].MtimeNs) {
		case StateLeftNewer:
			l[i] = true
		case StateRightNewer:
			r[j] = true
		case StateDifferent:
			l[i], r[j] = true, true
		}
	}
	for j, e := range right {
		if !e.IsDir && !matched[j] {
			r[j] = true
		}
	}
	return l, r
}
