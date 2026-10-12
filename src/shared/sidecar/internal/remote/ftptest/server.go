// Package ftptest is a small FTP and FTPS server over a local folder, for
// the tests of internal/remote and for the end-to-end fixture
// (cmd/ftpfixture). It listens on loopback only. It is not part of the
// sidecar: nothing in the app serves files.
package ftptest

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/text/encoding"
)

// Options shape a server. The zero value serves Root to anonymous users,
// without TLS, with MLSD, EPSV, REST and UTF-8.
type Options struct {
	// Root is the folder served as "/".
	Root string
	// User and Password; an empty User lets anyone in.
	User, Password string
	// TLS enables AUTH TLS (and, with Implicit, TLS from the first byte).
	TLS      *tls.Config
	Implicit bool
	// NoMLSD, NoEPSV, NoREST and NoUTF8 take features away, as old servers lack them.
	NoMLSD, NoEPSV, NoREST, NoUTF8 bool
	// DOSList makes LIST answer in the DOS (IIS) style.
	DOSList bool
	// NoListFlags refuses "LIST -a".
	NoListFlags bool
	// Encoding sends and reads names in a code page instead of UTF-8.
	Encoding encoding.Encoding
	// PasvHost is the address a PASV reply claims (a lie, when it is not ours).
	PasvHost string
	// ExtraList are raw lines added to every listing (hostile names).
	ExtraList []string
	// StallOn names a command ("LIST", "RETR", "PASV", "GREETING") the server
	// does not answer until Release is called or the client goes away.
	StallOn string
	// DropAfter cuts the first RETR after this many bytes (0 = never).
	DropAfter int64
	// DropStoreAfter cuts the first STOR after this many bytes (0 = never).
	DropStoreAfter int64
	// DiscardUploads receives a STOR without writing its data: the file gets
	// its length only. For throughput measurements that must not time this
	// computer's disk.
	DiscardUploads bool
	// Now dates the listing lines that carry no year.
	Now func() time.Time
}

// Server is a running test server.
type Server struct {
	Host string
	Port int

	o            Options
	l            net.Listener
	wg           sync.WaitGroup
	release      chan struct{}
	once         sync.Once
	dropped      atomic.Bool
	storeDropped atomic.Bool

	mu       sync.Mutex
	commands []string
	conns    map[net.Conn]struct{}
	// ClearPasswords counts PASS commands received without TLS.
	ClearPasswords atomic.Int64
	// Sessions counts control connections accepted.
	Sessions atomic.Int64
	// Stalled is closed when a session reaches StallOn.
	Stalled chan struct{}
	stalled sync.Once
}

// Start serves until Close.
func Start(o Options) (*Server, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	s := &Server{Host: "127.0.0.1", Port: l.Addr().(*net.TCPAddr).Port, o: o, l: l,
		release: make(chan struct{}), conns: map[net.Conn]struct{}{}, Stalled: make(chan struct{})}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			s.Sessions.Add(1)
			s.track(conn, true)
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				defer s.track(conn, false)
				s.serve(conn)
			}()
		}
	}()
	return s, nil
}

func (s *Server) track(c net.Conn, add bool) {
	s.mu.Lock()
	if add {
		s.conns[c] = struct{}{}
	} else {
		delete(s.conns, c)
	}
	s.mu.Unlock()
}

// Release lets stalled sessions go on.
func (s *Server) Release() { s.once.Do(func() { close(s.release) }) }

// Close stops the server and its sessions.
func (s *Server) Close() {
	s.Release()
	_ = s.l.Close()
	s.mu.Lock()
	for c := range s.conns {
		_ = c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

// Commands returns the commands received so far, without their arguments.
func (s *Server) Commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...)
}

// Count returns how often a command was received.
func (s *Server) Count(cmd string) int {
	n := 0
	for _, c := range s.Commands() {
		if c == cmd {
			n++
		}
	}
	return n
}

// DropConnections closes every control connection (the server "goes away").
func (s *Server) DropConnections() {
	s.mu.Lock()
	for c := range s.conns {
		_ = c.Close()
	}
	s.mu.Unlock()
}

// SelfSigned makes a certificate for the hosts (names or addresses), signed
// by itself: a client that checks certificates refuses it until it is pinned.
func SelfSigned(hosts ...string) (tls.Certificate, *x509.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "panelyth ftptest"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, leaf, nil
}

type session struct {
	s      *Server
	conn   net.Conn
	r      *bufio.Reader
	authed bool
	user   string
	secure bool // the control connection is encrypted
	protP  bool // data connections are encrypted
	cwd    string
	rest   int64
	rnfr   string
	pasv   net.Listener
	active string
}

func (s *Server) stall(cmd string, conn net.Conn) {
	if s.o.StallOn != cmd {
		return
	}
	s.stalled.Do(func() { close(s.Stalled) })
	gone := make(chan struct{})
	go func() {
		// The client hanging up ends the stall too.
		buf := make([]byte, 1)
		_ = conn.SetReadDeadline(time.Time{})
		for {
			if _, err := conn.Read(buf); err != nil {
				close(gone)
				return
			}
		}
	}()
	select {
	case <-s.release:
	case <-gone:
	}
}

func (s *Server) serve(conn net.Conn) {
	defer conn.Close()
	ss := &session{s: s, conn: conn, cwd: "/"}
	if s.o.StallOn == "GREETING" {
		s.stall("GREETING", conn)
	}
	if s.o.Implicit && s.o.TLS != nil {
		tc := tls.Server(conn, s.o.TLS)
		if err := tc.Handshake(); err != nil {
			return
		}
		ss.conn, ss.secure = tc, true
	}
	ss.r = bufio.NewReader(ss.conn)
	ss.reply(220, "panelyth ftptest ready")
	defer func() {
		if ss.pasv != nil {
			_ = ss.pasv.Close()
		}
	}()
	for {
		line, err := ss.r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		cmd, arg, _ := strings.Cut(line, " ")
		cmd = strings.ToUpper(cmd)
		s.mu.Lock()
		s.commands = append(s.commands, cmd)
		s.mu.Unlock()
		if cmd != "PASS" {
			arg = ss.decode(arg)
		}
		if s.o.StallOn == cmd {
			s.stall(cmd, ss.conn)
			select {
			case <-s.release:
			default:
				return // the client went away
			}
		}
		if !ss.handle(cmd, arg) {
			return
		}
	}
}

func (ss *session) decode(arg string) string {
	if ss.s.o.Encoding == nil {
		return arg
	}
	out, err := ss.s.o.Encoding.NewDecoder().String(arg)
	if err != nil {
		return arg
	}
	return out
}

func (ss *session) encode(name string) string {
	if ss.s.o.Encoding == nil {
		return name
	}
	out, err := ss.s.o.Encoding.NewEncoder().String(name)
	if err != nil {
		return name
	}
	return out
}

func (ss *session) reply(code int, msg string) {
	_, _ = fmt.Fprintf(ss.conn, "%d %s\r\n", code, msg)
}

// local maps a path of the client to a file below the root; ok is false for
// one that would leave it.
func (ss *session) local(arg string) (virtual, real string, ok bool) {
	p := arg
	if !strings.HasPrefix(p, "/") {
		p = path.Join(ss.cwd, p)
	}
	p = path.Clean(p)
	if !strings.HasPrefix(p, "/") {
		return "", "", false
	}
	real = filepath.Join(ss.s.o.Root, filepath.FromSlash(p))
	rel, err := filepath.Rel(ss.s.o.Root, real)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", "", false
	}
	return p, real, true
}

func (ss *session) handle(cmd, arg string) bool {
	o := ss.s.o
	switch cmd {
	case "QUIT":
		ss.reply(221, "bye")
		return false
	case "AUTH":
		if o.TLS == nil || !strings.EqualFold(arg, "TLS") {
			ss.reply(502, "TLS is not available here")
			return true
		}
		ss.reply(234, "go ahead")
		tc := tls.Server(ss.conn, o.TLS)
		if err := tc.Handshake(); err != nil {
			return false
		}
		ss.conn, ss.secure = tc, true
		ss.r = bufio.NewReader(tc)
		return true
	case "PBSZ":
		ss.reply(200, "PBSZ=0")
		return true
	case "PROT":
		if !ss.secure {
			ss.reply(503, "secure the control connection first")
			return true
		}
		ss.protP = strings.EqualFold(arg, "P")
		ss.reply(200, "protection level set")
		return true
	case "USER":
		ss.user, ss.authed = arg, false
		if o.User == "" {
			ss.authed = true
			ss.reply(230, "welcome")
		} else {
			ss.reply(331, "password, please")
		}
		return true
	case "PASS":
		if !ss.secure {
			ss.s.ClearPasswords.Add(1)
		}
		if o.User == "" || (ss.user == o.User && arg == o.Password) {
			ss.authed = true
			ss.reply(230, "welcome")
		} else {
			ss.reply(530, "Login incorrect.")
		}
		return true
	case "FEAT":
		lines := []string{"211-Features:"}
		if !o.NoMLSD {
			lines = append(lines, " MLSD", " MLST type*;size*;modify*;")
		}
		if !o.NoREST {
			lines = append(lines, " REST STREAM")
		}
		if !o.NoUTF8 && o.Encoding == nil {
			lines = append(lines, " UTF8")
		}
		if !o.NoEPSV {
			lines = append(lines, " EPSV")
		}
		lines = append(lines, " MDTM", " SIZE", "211 End")
		_, _ = io.WriteString(ss.conn, strings.Join(lines, "\r\n")+"\r\n")
		return true
	case "OPTS", "TYPE", "NOOP", "MODE", "STRU":
		ss.reply(200, "ok")
		return true
	case "SYST":
		ss.reply(215, "UNIX Type: L8")
		return true
	}
	if !ss.authed {
		ss.reply(530, "Please log in.")
		return true
	}
	switch cmd {
	case "PWD":
		ss.reply(257, fmt.Sprintf("%q is the current folder", ss.cwd))
	case "CWD":
		v, real, ok := ss.local(arg)
		if fi, err := os.Stat(real); !ok || err != nil || !fi.IsDir() {
			ss.reply(550, "No such folder.")
		} else {
			ss.cwd = v
			ss.reply(250, "ok")
		}
	case "EPSV":
		if o.NoEPSV {
			ss.reply(500, "EPSV is not understood")
			return true
		}
		if port, ok := ss.listen(); ok {
			ss.reply(229, fmt.Sprintf("Entering Extended Passive Mode (|||%d|)", port))
		}
	case "PASV":
		if port, ok := ss.listen(); ok {
			host := o.PasvHost
			if host == "" {
				host = "127.0.0.1"
			}
			ss.reply(227, fmt.Sprintf("Entering Passive Mode (%s,%d,%d).", strings.ReplaceAll(host, ".", ","), port>>8, port&0xff))
		}
	case "PORT":
		parts := strings.Split(arg, ",")
		if len(parts) != 6 {
			ss.reply(501, "bad PORT")
			return true
		}
		hi, _ := strconv.Atoi(parts[4])
		lo, _ := strconv.Atoi(parts[5])
		ss.active = net.JoinHostPort(strings.Join(parts[:4], "."), strconv.Itoa(hi<<8|lo))
		ss.reply(200, "ok")
	case "EPRT":
		parts := strings.Split(arg, "|")
		if len(parts) != 5 {
			ss.reply(501, "bad EPRT")
			return true
		}
		ss.active = net.JoinHostPort(parts[2], parts[3])
		ss.reply(200, "ok")
	case "REST":
		n, err := strconv.ParseInt(arg, 10, 64)
		if o.NoREST || err != nil || n < 0 {
			ss.reply(502, "REST is not available")
			return true
		}
		ss.rest = n
		ss.reply(350, "restarting at "+arg)
	case "LIST", "NLST":
		if strings.HasPrefix(arg, "-") {
			if o.NoListFlags {
				ss.reply(500, "LIST takes no options here")
				return true
			}
			arg = ""
		}
		ss.list(arg, false)
	case "MLSD":
		if o.NoMLSD {
			ss.reply(500, "MLSD is not understood")
			return true
		}
		ss.list(arg, true)
	case "RETR":
		ss.retr(arg)
	case "STOR":
		ss.stor(arg)
	case "SIZE":
		_, real, ok := ss.local(arg)
		if fi, err := os.Stat(real); !ok || err != nil || fi.IsDir() {
			ss.reply(550, "No such file.")
		} else {
			ss.reply(213, strconv.FormatInt(fi.Size(), 10))
		}
	case "MDTM":
		_, real, ok := ss.local(arg)
		if fi, err := os.Stat(real); !ok || err != nil {
			ss.reply(550, "No such file.")
		} else {
			ss.reply(213, fi.ModTime().UTC().Format("20060102150405"))
		}
	case "MKD":
		v, real, ok := ss.local(arg)
		if !ok {
			ss.reply(550, "Not allowed.")
		} else if err := os.Mkdir(real, 0o755); err != nil {
			ss.reply(550, "The folder could not be created: file exists.")
		} else {
			ss.reply(257, fmt.Sprintf("%q created", v))
		}
	case "RMD":
		_, real, ok := ss.local(arg)
		if fi, err := os.Stat(real); !ok || err != nil || !fi.IsDir() {
			ss.reply(550, "No such folder.")
		} else if err := os.Remove(real); err != nil {
			ss.reply(550, "The folder is not empty.")
		} else {
			ss.reply(250, "removed")
		}
	case "DELE":
		_, real, ok := ss.local(arg)
		if fi, err := os.Stat(real); !ok || err != nil || fi.IsDir() {
			ss.reply(550, "No such file.")
		} else if err := os.Remove(real); err != nil {
			ss.reply(550, "Permission denied.")
		} else {
			ss.reply(250, "deleted")
		}
	case "RNFR":
		_, real, ok := ss.local(arg)
		if _, err := os.Stat(real); !ok || err != nil {
			ss.reply(550, "No such file or folder.")
		} else {
			ss.rnfr = real
			ss.reply(350, "and to?")
		}
	case "RNTO":
		_, real, ok := ss.local(arg)
		if !ok || ss.rnfr == "" {
			ss.reply(503, "RNFR first")
		} else if _, err := os.Stat(real); err == nil {
			ss.reply(550, "The name is taken.")
		} else if err := os.Rename(ss.rnfr, real); err != nil {
			ss.reply(550, "The rename failed.")
		} else {
			ss.reply(250, "renamed")
		}
		ss.rnfr = ""
	default:
		ss.reply(502, cmd+" is not implemented")
	}
	return true
}

func (ss *session) listen() (int, bool) {
	if ss.pasv != nil {
		_ = ss.pasv.Close()
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		ss.reply(425, "no data port")
		return 0, false
	}
	ss.pasv, ss.active = l, ""
	return l.Addr().(*net.TCPAddr).Port, true
}

// data opens the data connection of the transfer that was just announced.
func (ss *session) data() (net.Conn, error) {
	var conn net.Conn
	var err error
	switch {
	case ss.active != "":
		conn, err = net.DialTimeout("tcp", ss.active, 5*time.Second)
		ss.active = ""
	case ss.pasv != nil:
		_ = ss.pasv.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
		conn, err = ss.pasv.Accept()
		_ = ss.pasv.Close()
		ss.pasv = nil
	default:
		err = errors.New("no data connection was set up")
	}
	if err != nil {
		return nil, err
	}
	if ss.protP {
		tc := tls.Server(conn, ss.s.o.TLS)
		if err := tc.Handshake(); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return tc, nil
	}
	return conn, nil
}

func (ss *session) list(arg string, mlsd bool) {
	o := ss.s.o
	_, real, ok := ss.local(arg)
	ents, err := os.ReadDir(real)
	if !ok || err != nil {
		ss.reply(550, "No such folder.")
		return
	}
	sort.Slice(ents, func(i, j int) bool { return ents[i].Name() < ents[j].Name() })
	now := o.Now()
	var b strings.Builder
	if mlsd {
		b.WriteString("type=cdir; .\r\ntype=pdir; ..\r\n")
	}
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		name := ss.encode(e.Name())
		mt := fi.ModTime().UTC()
		switch {
		case mlsd && fi.IsDir():
			fmt.Fprintf(&b, "type=dir;modify=%s; %s\r\n", mt.Format("20060102150405"), name)
		case mlsd:
			fmt.Fprintf(&b, "type=file;size=%d;modify=%s; %s\r\n", fi.Size(), mt.Format("20060102150405"), name)
		case o.DOSList && fi.IsDir():
			fmt.Fprintf(&b, "%s       <DIR>          %s\r\n", mt.Format("01-02-06  03:04PM"), name)
		case o.DOSList:
			fmt.Fprintf(&b, "%s %20d %s\r\n", mt.Format("01-02-06  03:04PM"), fi.Size(), name)
		default:
			kind := "-rw-r--r--"
			if fi.IsDir() {
				kind = "drwxr-xr-x"
			}
			date := mt.Format("Jan _2 15:04")
			if now.Sub(mt) > 180*24*time.Hour || mt.After(now) {
				date = mt.Format("Jan _2  2006")
			}
			fmt.Fprintf(&b, "%s 1 owner group %d %s %s\r\n", kind, fi.Size(), date, name)
		}
	}
	for _, line := range o.ExtraList {
		b.WriteString(line + "\r\n")
	}
	ss.reply(150, "here comes the listing")
	conn, err := ss.data()
	if err != nil {
		ss.reply(425, "no data connection")
		return
	}
	_, werr := io.WriteString(conn, b.String())
	_ = conn.Close()
	if werr != nil {
		ss.reply(426, "the listing was cut off")
		return
	}
	ss.reply(226, "done")
}

func (ss *session) retr(arg string) {
	_, real, ok := ss.local(arg)
	f, err := os.Open(real)
	if fi, serr := os.Stat(real); !ok || err != nil || serr != nil || fi.IsDir() {
		if f != nil {
			_ = f.Close()
		}
		ss.reply(550, "No such file.")
		return
	}
	defer f.Close()
	offset := ss.rest
	ss.rest = 0
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		ss.reply(550, "bad offset")
		return
	}
	ss.reply(150, "here it comes")
	conn, err := ss.data()
	if err != nil {
		ss.reply(425, "no data connection")
		return
	}
	var src io.Reader = f
	drop := ss.s.o.DropAfter > 0 && !ss.s.dropped.Swap(true)
	if drop {
		src = io.LimitReader(f, ss.s.o.DropAfter)
	}
	_, werr := io.Copy(conn, src)
	_ = conn.Close()
	if werr != nil || drop {
		ss.reply(426, "Connection closed; transfer aborted.")
		return
	}
	ss.reply(226, "done")
}

func (ss *session) stor(arg string) {
	_, real, ok := ss.local(arg)
	if !ok {
		ss.reply(550, "Not allowed.")
		return
	}
	offset := ss.rest
	ss.rest = 0
	flags := os.O_WRONLY | os.O_CREATE
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(real, flags, 0o644)
	if err != nil {
		ss.reply(550, "The file could not be written.")
		return
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		ss.reply(550, "bad offset")
		return
	}
	ss.reply(150, "send it")
	conn, err := ss.data()
	if err != nil {
		ss.reply(425, "no data connection")
		return
	}
	var src io.Reader = conn
	drop := ss.s.o.DropStoreAfter > 0 && !ss.s.storeDropped.Swap(true)
	if drop {
		src = io.LimitReader(conn, ss.s.o.DropStoreAfter)
	}
	var rerr error
	if ss.s.o.DiscardUploads {
		var n int64
		if n, rerr = io.Copy(io.Discard, src); rerr == nil {
			rerr = f.Truncate(offset + n)
		}
	} else {
		_, rerr = io.Copy(f, src)
	}
	_ = conn.Close()
	if rerr != nil || drop {
		ss.reply(426, "the upload was cut off")
		return
	}
	ss.reply(226, "stored")
}
