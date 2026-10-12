package rename

import (
	"slices"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/pathkey"
)

// Status says what happens to one entry of a batch.
type Status uint8

const (
	// Renamed entries get their new name.
	Renamed Status = iota
	// Unchanged entries already have it.
	Unchanged
	// Invalid names cannot exist on this platform.
	Invalid
	// Conflict: the name is not free.
	Conflict
)

// Reasons of a conflict.
const (
	// ReasonDuplicate: another entry of the batch gets the same name.
	ReasonDuplicate = "duplicate"
	// ReasonExists: an entry that keeps its name has it.
	ReasonExists = "exists"
	// ReasonCycle: entries exchange names; no order frees one of them.
	ReasonCycle = "cycle"
)

// Entry is an Item in its folder. Names collide per folder.
type Entry struct {
	Item
	// Dir is the folder's key (pathkey.DirKey).
	Dir string
}

// Outcome is the new name of an entry and whether it can have it.
type Outcome struct {
	Name   string
	Status Status
	// Reason is one of the Reason constants for a conflict and the
	// validation message for an invalid name.
	Reason string
}

// Result is a resolved batch.
type Result struct {
	Outcomes []Outcome
	// Order lists the entries to rename, each after the entry that still has
	// its new name.
	Order     []int
	Renamed   int
	Unchanged int
	Invalid   int
	Conflicts int
}

// Key is how a name is compared in its folder: as the platform compares
// names. A file and a folder of one name collide.
func Key(dir, name string) string { return pathkey.ChildKey(dir, name, false) }

// Resolve names every entry (the counter follows their order) and finds the
// names that are invalid or not free: taken by another entry of the batch,
// by an entry that keeps its name (exists reports whether the folder of
// entry i has an entry of that name outside the batch), or exchanged in a
// cycle. An entry waiting for a name that is never
// freed is a conflict too, so what Resolve calls renamed can be applied in
// Order without a temporary name.
func Resolve(p *Plan, entries []Entry, exists func(i int, name string) bool) Result {
	return resolve(p.Name, entries, exists)
}

func resolve(nameOf func(Item, int) string, entries []Entry, exists func(i int, name string) bool) Result {
	n := len(entries)
	res := Result{Outcomes: make([]Outcome, n)}
	out := res.Outcomes
	oldKey, newKey := make([]string, n), make([]string, n)
	holder := make(map[string]int, n) // who has a name now
	for i, e := range entries {
		name := nameOf(e.Item, i)
		out[i].Name = name
		oldKey[i] = Key(e.Dir, e.Name)
		holder[oldKey[i]] = i
		switch err := fileops.ValidateName(name); {
		case name == e.Name:
			out[i].Status = Unchanged
		case err != nil:
			out[i].Status, out[i].Reason = Invalid, err.Error()
		default:
			newKey[i] = Key(e.Dir, name)
		}
	}
	var stuck []int // entries that keep their name after all
	conflict := func(i int, reason string) {
		if out[i].Status == Renamed {
			out[i].Status, out[i].Reason = Conflict, reason
			stuck = append(stuck, i)
		}
	}
	target := make(map[string]int, n)
	for i := range entries {
		if out[i].Status != Renamed {
			continue
		}
		if j, taken := target[newKey[i]]; taken {
			conflict(i, ReasonDuplicate)
			conflict(j, ReasonDuplicate)
			continue
		}
		target[newKey[i]] = i
	}
	// dep[i] is the entry that has i's new name and gives it up; waiter is
	// the reverse (one at most: duplicates are conflicts already).
	dep, waiter := make([]int, n), make([]int, n)
	for i := range entries {
		dep[i], waiter[i] = -1, -1
	}
	for i := range entries {
		if out[i].Status != Renamed {
			continue
		}
		h, inBatch := holder[newKey[i]]
		switch {
		case inBatch && h == i: // only the case changes
		case inBatch && out[h].Status != Renamed:
			conflict(i, ReasonExists)
		case inBatch:
			dep[i], waiter[h] = h, i
		case exists(i, out[i].Name):
			conflict(i, ReasonExists)
		}
	}
	// Entries exchanging names: follow each chain once.
	mark := make([]int, n)
	for i, walk := 0, 0; i < n; i++ {
		if out[i].Status != Renamed || mark[i] != 0 {
			continue
		}
		walk++
		j := i
		for j >= 0 && out[j].Status == Renamed && mark[j] == 0 {
			mark[j] = walk
			j = dep[j]
		}
		if j >= 0 && out[j].Status == Renamed && mark[j] == walk {
			for k := j; ; {
				next := dep[k]
				conflict(k, ReasonCycle)
				if k = next; k == j {
					break
				}
			}
		}
	}
	// Whoever waits for an entry that stays, stays too.
	for len(stuck) > 0 {
		s := stuck[len(stuck)-1]
		stuck = stuck[:len(stuck)-1]
		if w := waiter[s]; w >= 0 {
			conflict(w, ReasonExists)
		}
	}
	res.Order = make([]int, 0, n)
	placed := make([]bool, n)
	var chain []int
	for i := range entries {
		chain = chain[:0]
		for j := i; j >= 0 && out[j].Status == Renamed && !placed[j]; j = dep[j] {
			placed[j] = true
			chain = append(chain, j)
		}
		for _, j := range slices.Backward(chain) {
			res.Order = append(res.Order, j)
		}
	}
	for i := range out {
		switch out[i].Status {
		case Renamed:
			res.Renamed++
		case Unchanged:
			res.Unchanged++
		case Invalid:
			res.Invalid++
		case Conflict:
			res.Conflicts++
		}
	}
	return res
}
