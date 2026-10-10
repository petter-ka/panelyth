package query

import (
	"context"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/scan"
)

// The viewer's hot path through a session: open a 10k-file folder and page
// it in 200-row pages from the index. Stage C07's regression gate for the
// session-source change (rows from sources, single-folder sources).
func BenchmarkOpenAndPage10k(b *testing.B) {
	ctx := context.Background()
	s, err := index.Open(filepath.Join(b.TempDir(), "index.db"), quiet)
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	dir := filepath.Join(b.TempDir(), "q")
	if _, err := fixture.Generate(dir, fixture.Spec{Files: 10_000}); err != nil {
		b.Fatal(err)
	}
	root, _ := s.EnsureDir(ctx, dir)
	if st := scan.Run(ctx, s, quiet, scan.Options{}, scan.Hooks{}, 1, s.NextGeneration(), root, false); st.State != scan.StateCompleted {
		b.Fatalf("scan %s", st.State)
	}
	m := NewManager(s, quiet, Options{}, nil)
	defer m.Shutdown()
	d := index.Descriptor{DirID: root.ID, Sort: []index.SortKey{{Field: index.SortName}}}
	for b.Loop() {
		snap, err := m.Open(ctx, d)
		if err != nil {
			b.Fatal(err)
		}
		for off := 0; off < snap.Total; off += 200 {
			if _, err := m.Page(ctx, snap.QueryID, off, 200); err != nil {
				b.Fatal(err)
			}
		}
		m.Close(snap.QueryID)
	}
}
