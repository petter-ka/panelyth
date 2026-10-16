package app

import (
	"testing"

	"panelyth/sidecar/internal/query"
)

// A search runs in the session budget of the app that started it (ADR-0042);
// a caller without an app is the commander, as before.
func TestFindOwner(t *testing.T) {
	for app, want := range map[string]query.Owner{
		"system":    query.OwnerSystem,
		"commander": query.OwnerCommander,
		"viewer":    query.OwnerViewer,
		"":          query.OwnerCommander,
	} {
		if got := findOwner(app); got != want {
			t.Errorf("findOwner(%q) = %q, want %q", app, got, want)
		}
	}
}
