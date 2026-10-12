package remote

import (
	"strconv"
	"strings"
	"time"
)

// Folder listings as servers send them: MLSD (RFC 3659, one fact list per
// entry) and the two families of LIST output, Unix "ls -l" and DOS (IIS).
// LIST has no standard, so its parser reads what is common to the dialects
// and gives up on a line rather than guess.

// parseMLSD reads one MLSD line: "type=file;size=12;modify=20261012101500; name".
// ok is false for the entries of the folder itself and its parent, and for
// lines that are not entries.
func parseMLSD(line string) (e Entry, ok bool) {
	facts, name, found := strings.Cut(line, " ")
	if !found || name == "" {
		return e, false
	}
	e.Name = name
	kind := ""
	for fact := range strings.SplitSeq(facts, ";") {
		k, v, _ := strings.Cut(fact, "=")
		switch strings.ToLower(k) {
		case "type":
			kind = strings.ToLower(v)
		case "size", "sizd":
			if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
				e.Size = n
			}
		case "modify":
			e.MtimeNs = mlsdTime(v)
		}
	}
	switch {
	case kind == "file":
		e.Kind = KindFile
	case kind == "dir":
		e.Kind, e.Size = KindDir, 0
	case strings.HasPrefix(kind, "os.unix=slink"), strings.HasPrefix(kind, "os.unix=symlink"):
		e.Kind = KindLink
	default:
		// cdir, pdir and kinds this app does not know.
		return e, false
	}
	return e, true
}

// mlsdTime reads "YYYYMMDDHHMMSS[.sss]" (UTC); 0 when it is not a time.
func mlsdTime(v string) int64 {
	layout := "20060102150405"
	if len(v) > len(layout) && v[len(layout)] == '.' {
		layout += "." + strings.Repeat("0", len(v)-len(layout)-1)
	}
	t, err := time.ParseInLocation(layout, v, time.UTC)
	if err != nil {
		return 0
	}
	return t.UnixNano()
}

// parseLIST reads one line of LIST output. now dates the lines that have a
// time instead of a year (the last twelve months).
func parseLIST(line string, now time.Time) (Entry, bool) {
	line = strings.TrimRight(line, "\r\n")
	if line == "" || strings.HasPrefix(line, "total ") {
		return Entry{}, false
	}
	if e, ok := parseDOS(line); ok {
		return e, true
	}
	return parseUnix(line, now)
}

var months = map[string]time.Month{
	"jan": time.January, "feb": time.February, "mar": time.March, "apr": time.April,
	"may": time.May, "jun": time.June, "jul": time.July, "aug": time.August,
	"sep": time.September, "oct": time.October, "nov": time.November, "dec": time.December,
}

// parseUnix reads "-rw-r--r-- 1 owner group 1234 Jan  2 15:04 name" and its
// variants: no group column, numeric owners, a year in place of the time,
// "name -> target" for links. The month is the anchor: the size is the
// field before it, the name everything after the date.
func parseUnix(line string, now time.Time) (Entry, bool) {
	if len(line) < 10 {
		return Entry{}, false
	}
	var e Entry
	switch line[0] {
	case '-':
		e.Kind = KindFile
	case 'd':
		e.Kind = KindDir
	case 'l':
		e.Kind = KindLink
	default:
		// Devices, sockets and pipes are not files to transfer.
		return Entry{}, false
	}
	// Fields are separated by runs of spaces; the name keeps its own spaces.
	rest := line
	var fields []string
	var starts []int
	for i := 0; i < len(rest); {
		for i < len(rest) && rest[i] == ' ' {
			i++
		}
		if i == len(rest) {
			break
		}
		j := i
		for j < len(rest) && rest[j] != ' ' {
			j++
		}
		fields = append(fields, rest[i:j])
		starts = append(starts, i)
		i = j
	}
	// The month is at field 4 (no group) to 6 (an extra column); the size before it.
	for m := 3; m < len(fields)-2 && m <= 7; m++ {
		month, ok := months[strings.ToLower(fields[m])]
		if !ok {
			continue
		}
		size, err := strconv.ParseInt(fields[m-1], 10, 64)
		day, derr := strconv.Atoi(fields[m+1])
		if err != nil || derr != nil || size < 0 || day < 1 || day > 31 || m+3 >= len(fields) {
			continue
		}
		when, ok := unixDate(month, day, fields[m+2], now)
		if !ok {
			continue
		}
		// The name starts one space after the time or year field.
		nameAt := starts[m+2] + len(fields[m+2]) + 1
		if nameAt >= len(rest) {
			return Entry{}, false
		}
		e.Name = rest[nameAt:]
		if e.Kind == KindLink {
			if name, _, found := strings.Cut(e.Name, " -> "); found {
				e.Name = name
			}
		}
		if e.Kind == KindFile {
			e.Size = size
		}
		e.MtimeNs = when.UnixNano()
		return e, e.Name != ""
	}
	return Entry{}, false
}

// unixDate reads the last date field of an "ls -l" line: "15:04" (a date in
// the last twelve months) or "2006".
func unixDate(month time.Month, day int, field string, now time.Time) (time.Time, bool) {
	if h, m, ok := strings.Cut(field, ":"); ok {
		hour, herr := strconv.Atoi(h)
		minute, merr := strconv.Atoi(m)
		if herr != nil || merr != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
			return time.Time{}, false
		}
		t := time.Date(now.Year(), month, day, hour, minute, 0, 0, time.UTC)
		// A date "in the future" is last year's (a day of slack for time zones).
		if t.After(now.Add(24 * time.Hour)) {
			t = t.AddDate(-1, 0, 0)
		}
		return t, true
	}
	year, err := strconv.Atoi(field)
	if err != nil || year < 1970 || year > 9999 {
		return time.Time{}, false
	}
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC), true
}

// parseDOS reads "10-12-26  03:04PM       <DIR>          name" and
// "10-12-2026  15:04             1234 name" (IIS and other DOS-style servers).
func parseDOS(line string) (Entry, bool) {
	if len(line) < 20 || line[2] != '-' || line[5] != '-' {
		return Entry{}, false
	}
	date, rest, ok := strings.Cut(line, " ")
	if !ok {
		return Entry{}, false
	}
	rest = strings.TrimLeft(rest, " ")
	clock, rest, ok := strings.Cut(rest, " ")
	if !ok {
		return Entry{}, false
	}
	rest = strings.TrimLeft(rest, " ")
	sizeOrDir, name, ok := strings.Cut(rest, " ")
	if !ok {
		return Entry{}, false
	}
	// One space separates the size from the name; a name may start with spaces.
	var e Entry
	if strings.EqualFold(sizeOrDir, "<DIR>") {
		e.Kind = KindDir
		name = strings.TrimLeft(name, " ")
	} else {
		size, err := strconv.ParseInt(sizeOrDir, 10, 64)
		if err != nil || size < 0 {
			return Entry{}, false
		}
		e.Size = size
	}
	var when time.Time
	var err error
	for _, layout := range []string{"01-02-06 03:04PM", "01-02-2006 03:04PM", "01-02-06 15:04", "01-02-2006 15:04"} {
		if when, err = time.ParseInLocation(layout, date+" "+strings.ToUpper(clock), time.UTC); err == nil {
			break
		}
	}
	if err != nil || name == "" {
		return Entry{}, false
	}
	e.Name, e.MtimeNs = name, when.UnixNano()
	return e, true
}
