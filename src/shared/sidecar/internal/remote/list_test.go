package remote

import (
	"testing"
	"time"
)

func TestSafeNames(t *testing.T) {
	for _, name := range []string{"a.txt", "with space.txt", "ünïcödé.jpg", ".hidden", "12:30.log", "trailing.", "日本語"} {
		if !SafeName(name) {
			t.Errorf("%q should be listed", name)
		}
	}
	for _, name := range []string{"", ".", "..", "a/b", "../evil", `a\b`, "line\nRETR x", "cr\rx", "nul\x00", "tab\tx", "bad\xffutf8", string(make([]byte, MaxNameBytes+1))} {
		if SafeName(name) {
			t.Errorf("%q must not be listed", name)
		}
	}
}

func TestCleanDir(t *testing.T) {
	for in, want := range map[string]string{
		"/":             "/",
		"//":            "/",
		"/pub":          "/pub",
		"/pub/":         "/pub",
		"/pub//photos/": "/pub/photos",
	} {
		if got, ok := CleanDir(in); !ok || got != want {
			t.Errorf("CleanDir(%q) = %q %v, want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "pub", "/pub/../etc", "/a/./b", "/a\nb", `/a\b`} {
		if got, ok := CleanDir(in); ok {
			t.Errorf("CleanDir(%q) = %q, want refused", in, got)
		}
	}
	if Join("/", "a") != "/a" || Join("/a", "b") != "/a/b" || Parent("/a/b") != "/a" || Parent("/a") != "/" || Parent("/") != "/" || Base("/a/b") != "b" || Base("/") != "/" {
		t.Error("Join, Parent or Base")
	}
}

func TestParseMLSD(t *testing.T) {
	when := time.Date(2026, 10, 12, 10, 15, 0, 0, time.UTC).UnixNano()
	cases := []struct {
		line string
		want Entry
		ok   bool
	}{
		{"type=file;size=1234;modify=20261012101500; report final.pdf", Entry{Name: "report final.pdf", Size: 1234, MtimeNs: when}, true},
		{"Type=dir;Modify=20261012101500;Perm=el; photos", Entry{Name: "photos", Kind: KindDir, MtimeNs: when}, true},
		{"type=file;size=5;modify=20261012101500.123; a.txt", Entry{Name: "a.txt", Size: 5, MtimeNs: when + 123e6}, true},
		{"type=OS.unix=slink:/target;size=4; link", Entry{Name: "link", Kind: KindLink, Size: 4}, true},
		// The folder itself, its parent, unknown kinds and lines that are not entries.
		{"type=cdir;modify=20261012101500; .", Entry{}, false},
		{"type=pdir; ..", Entry{}, false},
		{"type=OS.unix=chr-1/3; null", Entry{}, false},
		{"garbage", Entry{}, false},
		{"type=file;size=1; ", Entry{}, false},
		// A bad size or date leaves the field unknown; the entry is still listed.
		{"type=file;size=-3;modify=yesterday; odd", Entry{Name: "odd"}, true},
	}
	for _, c := range cases {
		got, ok := parseMLSD(c.line)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("%q: %+v %v, want %+v %v", c.line, got, ok, c.want, c.ok)
		}
	}
}

func TestParseLIST(t *testing.T) {
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	at := func(y int, m time.Month, d, h, min int) int64 {
		return time.Date(y, m, d, h, min, 0, 0, time.UTC).UnixNano()
	}
	cases := []struct {
		name string
		line string
		want Entry
		ok   bool
	}{
		{"unix, this year", "-rw-r--r--   1 alice    staff        1234 Oct  2 15:04 notes.txt",
			Entry{Name: "notes.txt", Size: 1234, MtimeNs: at(2026, time.October, 2, 15, 4)}, true},
		{"unix, a year", "drwxr-xr-x   2 alice    staff        4096 Jan 15  2019 old photos",
			Entry{Name: "old photos", Kind: KindDir, MtimeNs: at(2019, time.January, 15, 0, 0)}, true},
		{"unix, no group column", "-rw-r--r--   1 ftp            77 Mar  9 08:30 a b  c.txt",
			Entry{Name: "a b  c.txt", Size: 77, MtimeNs: at(2026, time.March, 9, 8, 30)}, true},
		{"unix, numeric owners", "-rw-rw-r--    1 1000     1000      9000000000 Sep 30 23:59 big.iso",
			Entry{Name: "big.iso", Size: 9_000_000_000, MtimeNs: at(2026, time.September, 30, 23, 59)}, true},
		// A month still to come this year is last year's.
		{"unix, last December", "-rw-r--r-- 1 a b 1 Dec 24 18:00 gift.txt",
			Entry{Name: "gift.txt", Size: 1, MtimeNs: at(2025, time.December, 24, 18, 0)}, true},
		{"unix, a link", "lrwxrwxrwx 1 a b 11 Oct  1 10:00 current -> releases/42",
			Entry{Name: "current", Kind: KindLink, MtimeNs: at(2026, time.October, 1, 10, 0)}, true},
		{"unix, a name that looks like a date", "-rw-r--r-- 1 a b 3 Oct  1 10:00 Jan 2 2020",
			Entry{Name: "Jan 2 2020", Size: 3, MtimeNs: at(2026, time.October, 1, 10, 0)}, true},
		{"dos, a folder", "10-12-26  03:04PM       <DIR>          My Documents",
			Entry{Name: "My Documents", Kind: KindDir, MtimeNs: at(2026, time.October, 12, 15, 4)}, true},
		{"dos, a file", "01-05-2024  09:30AM              4096 setup.exe",
			Entry{Name: "setup.exe", Size: 4096, MtimeNs: at(2024, time.January, 5, 9, 30)}, true},
		{"dos, 24 hours", "10-12-26  15:04                 12 a.txt",
			Entry{Name: "a.txt", Size: 12, MtimeNs: at(2026, time.October, 12, 15, 4)}, true},
		{"the total line", "total 48", Entry{}, false},
		{"a device", "crw-rw-rw- 1 root root 1, 3 Oct  1 10:00 null", Entry{}, false},
		{"no name", "-rw-r--r-- 1 a b 3 Oct  1 10:00", Entry{}, false},
		{"not a listing", "Welcome to the server", Entry{}, false},
		{"empty", "", Entry{}, false},
	}
	for _, c := range cases {
		got, ok := parseLIST(c.line, now)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("%s: %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestParsePassiveReplies(t *testing.T) {
	if got := parseEPSV("Entering Extended Passive Mode (|||50123|)"); got != 50123 {
		t.Errorf("EPSV: %d", got)
	}
	for _, bad := range []string{"", "nothing here", "(|||0|)", "(|||99999|)", "(||50123|)"} {
		if got := parseEPSV(bad); got != 0 {
			t.Errorf("EPSV %q: %d", bad, got)
		}
	}
	// Only the port is read; the address is whatever the server claims.
	for msg, want := range map[string]int{
		"Entering Passive Mode (10,0,0,7,195,203).": 195<<8 | 203,
		"Entering Passive Mode (127,0,0,1,4,1)":     4<<8 | 1,
		"227 =127,0,0,1,200,10":                     200<<8 | 10,
	} {
		if got := parsePASV(msg); got != want {
			t.Errorf("PASV %q: %d, want %d", msg, got, want)
		}
	}
	for _, bad := range []string{"", "Entering Passive Mode", "(1,2,3,4,5)", "(1,2,3,4,256,1)", "(a,b,c,d,e,f)"} {
		if got := parsePASV(bad); got != 0 {
			t.Errorf("PASV %q: %d", bad, got)
		}
	}
}
