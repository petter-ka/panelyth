// Command ftpfixture serves a folder over FTP or FTPS on loopback for the
// end-to-end tests and benchmarks of the commander's connections (Stage
// C10.5, ADR-0037). It is test tooling: nothing in the app serves files.
//
//	go run ./cmd/ftpfixture -root <dir> [-user u -password p] [-tls] [-stall LIST] [-discard-uploads]
//
// It prints one JSON line with the address (and, with -tls, the fingerprint
// of its self-signed certificate), then serves until its standard input
// closes. Lines on standard input are commands: "stats" prints what the
// server has seen so far, "drop" closes every control connection, "release"
// lets stalled sessions go on.
package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/remote/ftptest"
)

type started struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Fingerprint string `json:"fingerprint"`
}

type stats struct {
	// Sessions counts control connections accepted since the start.
	Sessions int64 `json:"sessions"`
	// ClearPasswords counts PASS commands received without TLS.
	ClearPasswords int64 `json:"clearPasswords"`
	// Commands counts each command received.
	Commands map[string]int `json:"commands"`
}

func main() {
	root := flag.String("root", "", "the folder served as /")
	user := flag.String("user", "", "the user name (empty: anyone)")
	password := flag.String("password", "", "the user's password")
	useTLS := flag.Bool("tls", false, "offer AUTH TLS with a self-signed certificate")
	implicit := flag.Bool("implicit", false, "with -tls: TLS from the first byte")
	stall := flag.String("stall", "", "a command the server does not answer until \"release\" (LIST, RETR, PASV, GREETING)")
	noMLSD := flag.Bool("no-mlsd", false, "an old server: LIST only")
	discard := flag.Bool("discard-uploads", false, "receive uploads without writing their data (throughput measurements)")
	flag.Parse()
	if *root == "" {
		fmt.Fprintln(os.Stderr, "ftpfixture: -root is required")
		os.Exit(2)
	}
	o := ftptest.Options{Root: *root, User: *user, Password: *password, Implicit: *implicit,
		StallOn: *stall, NoMLSD: *noMLSD, DiscardUploads: *discard}
	out := started{}
	if *useTLS {
		cert, leaf, err := ftptest.SelfSigned("127.0.0.1", "localhost")
		if err != nil {
			fmt.Fprintln(os.Stderr, "ftpfixture:", err)
			os.Exit(1)
		}
		o.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		out.Fingerprint = remote.Fingerprint(leaf)
	}
	s, err := ftptest.Start(o)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ftpfixture:", err)
		os.Exit(1)
	}
	defer s.Close()
	out.Host, out.Port = s.Host, s.Port
	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(out)

	// Until the parent closes our input (it exited, or is done with us).
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		switch strings.TrimSpace(in.Text()) {
		case "stats":
			st := stats{Sessions: s.Sessions.Load(), ClearPasswords: s.ClearPasswords.Load(), Commands: map[string]int{}}
			for _, c := range s.Commands() {
				st.Commands[c]++
			}
			_ = enc.Encode(st)
		case "drop":
			s.DropConnections()
			_ = enc.Encode(map[string]bool{"ok": true})
		case "release":
			s.Release()
			_ = enc.Encode(map[string]bool{"ok": true})
		}
	}
	if err := in.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "ftpfixture:", err)
	}
}
