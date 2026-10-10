package fsx

import "sync"

// Volume facts the job queue needs (Stage P03, ADR-0029): which volume a
// path is on (a lane per source and destination volume), whether it is a
// spinning disk (small files go one at a time there), and whether names
// written to it follow Windows rules (FAT, exFAT, NTFS).

var rotational sync.Map // volume id -> bool

// IsRotational reports whether path's volume has a seek penalty (an HDD).
// Unknown answers false. Cached per volume.
func IsRotational(path string) bool {
	id := VolumeID(path)
	if v, ok := rotational.Load(id); ok {
		return v.(bool)
	}
	r := isRotational(path)
	rotational.Store(id, r)
	return r
}
