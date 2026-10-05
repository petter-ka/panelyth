package platform

import (
	"path/filepath"
	"testing"
)

func TestResolveDirsOverrides(t *testing.T) {
	cache := t.TempDir()
	config := t.TempDir()
	env := map[string]string{"FASTVIEW_CACHE_DIR": cache, "FASTVIEW_CONFIG_DIR": config}
	d, err := ResolveDirs(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if d.CacheRoot != filepath.Join(cache, "v1") {
		t.Fatalf("cache root %q", d.CacheRoot)
	}
	if d.ConfigRoot != config {
		t.Fatalf("config root %q", d.ConfigRoot)
	}
}

func TestResolveDirsDefaultsAreSeparate(t *testing.T) {
	d, err := ResolveDirs(func(string) string { return "" })
	if err != nil {
		t.Skipf("no user cache/config dir on this machine: %v", err)
	}
	if d.CacheRoot == d.ConfigRoot {
		t.Fatal("disposable cache and user data must not share a root")
	}
	if filepath.Base(d.CacheRoot) != "v1" || filepath.Base(filepath.Dir(d.CacheRoot)) != "FastView" {
		t.Fatalf("unexpected cache root %q", d.CacheRoot)
	}
}
