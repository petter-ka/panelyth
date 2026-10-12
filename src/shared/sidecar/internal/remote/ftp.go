package remote

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/htmlindex"
)

// The FTP client (RFC 959, 2228, 2428, 3659), written on net/textproto: the
// commands a file manager needs are few, and owning them lets every dial,
// command and transfer carry a context and a timeout, and lets the client
// ignore the host of a PASV reply.

// Timeouts. Vars so tests can shorten them.
var (
	DialTimeout    = 10 * time.Second
	CommandTimeout = 30 * time.Second
	// DataIdle is how long a transfer may move no byte before it has stalled.
	DataIdle = 60 * time.Second
	// abortWait is how long the reply of a cut-off transfer is waited for.
	abortWait = 5 * time.Second
)

// MaxDirEntries bounds one folder's listing.
const MaxDirEntries = 200_000

// maxListLine bounds one line of a listing (a name of MaxNameBytes plus its facts).
const maxListLine = 16 << 10

const transferBuffer = 256 << 10

var transferPool = sync.Pool{New: func() any { b := make([]byte, transferBuffer); return &b }}

type ftpClient struct {
	opts   Options
	host   string // where data connections go: always the control connection's host
	conn   net.Conn
	text   *textproto.Conn
	tlsCfg *tls.Config // nil for plain FTP
	feat   Features
	enc    encoding.Encoding // nil = UTF-8
	// epsvOff: the server refused EPSV; PASV from then on.
	epsvOff bool
	// listPlain: the server refused "LIST -a"; plain LIST from then on.
	listPlain bool
	broken    atomic.Bool
	now       func() time.Time
}

// Fingerprint is the SHA-256 of a certificate as the app shows and stores it.
func Fingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

// tlsConfig verifies the server: the pinned certificate when the connection
// has one, else the system's roots for the host name. A certificate that
// does not pass is reported with its fingerprint, never accepted silently.
func tlsConfig(o Options) *tls.Config {
	return &tls.Config{
		ServerName: o.Host,
		MinVersion: tls.VersionTLS12,
		// Data connections resume the control connection's session (servers
		// such as vsftpd require it).
		ClientSessionCache: tls.NewLRUClientSessionCache(8),
		// Verification happens in VerifyConnection, for the pin's sake.
		InsecureSkipVerify: true, //nolint:gosec // verified below
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return &CertificateError{Err: errors.New("the server sent no certificate")}
			}
			leaf := cs.PeerCertificates[0]
			print := Fingerprint(leaf)
			if o.Fingerprint != "" {
				if strings.EqualFold(o.Fingerprint, print) {
					return nil
				}
				return &CertificateError{Fingerprint: print, Subject: leaf.Subject.String(), Changed: true,
					Err: errors.New("it is not the certificate that was accepted for this connection")}
			}
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			if _, err := leaf.Verify(x509.VerifyOptions{DNSName: o.Host, Intermediates: inter}); err != nil {
				return &CertificateError{Fingerprint: print, Subject: leaf.Subject.String(), Err: err}
			}
			return nil
		},
	}
}

// Dial connects and logs in. It returns ErrTLSRequired when the connection
// asks for TLS and the server has none, a *CertificateError for a
// certificate that does not verify, and ErrAuth for a refused login.
func Dial(ctx context.Context, o Options) (Client, error) {
	if o.Host == "" || strings.ContainsAny(o.Host, " \r\n\t/") || o.Port < 1 || o.Port > 65535 || !o.TLS.Valid() {
		return nil, fmt.Errorf("remote: invalid connection")
	}
	c := &ftpClient{opts: o, host: o.Host, now: time.Now}
	if e := strings.ToLower(o.Encoding); e != "" && e != "utf-8" && e != "utf8" {
		enc, err := htmlindex.Get(e)
		if err != nil {
			return nil, fmt.Errorf("remote: unknown encoding %q", o.Encoding)
		}
		c.enc = enc
	}
	dctx, cancel := context.WithTimeout(ctx, DialTimeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(dctx, "tcp", net.JoinHostPort(o.Host, strconv.Itoa(o.Port)))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	c.conn = conn
	if err := c.login(ctx); err != nil {
		_ = c.conn.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	return c, nil
}

func (c *ftpClient) login(ctx context.Context) error {
	o := c.opts
	if o.TLS != TLSNone {
		c.tlsCfg = tlsConfig(o)
	}
	if o.TLS == TLSImplicit {
		if err := c.startTLS(ctx); err != nil {
			return err
		}
	}
	c.text = textproto.NewConn(c.conn)
	if code, msg, err := c.reply(ctx); err != nil {
		return err
	} else if code/100 != 2 {
		return &ServerError{Code: code, Msg: msg}
	}
	if o.TLS == TLSExplicit {
		code, _, err := c.cmd(ctx, "AUTH TLS")
		if err != nil {
			return err
		}
		// No TLS on offer: stop here. The password is never sent in the clear
		// for a connection that asked for encryption.
		if code != 234 {
			return ErrTLSRequired
		}
		if err := c.startTLS(ctx); err != nil {
			return err
		}
		c.text = textproto.NewConn(c.conn)
	}
	if c.tlsCfg != nil {
		// The data connections are encrypted too, or there is no connection.
		for _, line := range []string{"PBSZ 0", "PROT P"} {
			if code, _, err := c.cmd(ctx, "%s", line); err != nil {
				return err
			} else if code/100 != 2 {
				return ErrTLSRequired
			}
		}
		c.feat.TLS = true
	}
	user, pass := o.User, o.Password
	if user == "" {
		user, pass = "anonymous", "anonymous@"
	}
	if !sendable(user) || !sendable(pass) {
		return ErrAuth
	}
	code, msg, err := c.cmd(ctx, "USER %s", user)
	if err != nil {
		return err
	}
	if code == 331 {
		if code, msg, err = c.cmd(ctx, "PASS %s", pass); err != nil {
			return err
		}
	}
	switch {
	case code == 230 || code == 202:
	case code == 332:
		return fmt.Errorf("%w: the server asks for an account", ErrUnsupported)
	case code == 530 || code == 430 || code == 331:
		return fmt.Errorf("%w: %s", ErrAuth, clean(msg))
	default:
		return &ServerError{Code: code, Msg: clean(msg)}
	}
	if code, msg, err := c.cmd(ctx, "FEAT"); err != nil {
		return err
	} else if code == 211 {
		for line := range strings.SplitSeq(msg, "\n") {
			f := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(f, "MLSD"), strings.HasPrefix(f, "MLST"):
				c.feat.MLSD = true
			case strings.HasPrefix(f, "REST") && strings.Contains(f, "STREAM"):
				c.feat.Resume = true
			case f == "UTF8":
				c.feat.UTF8 = true
			case f == "MDTM":
				c.feat.MDTM = true
			}
		}
	}
	if c.feat.UTF8 && c.enc == nil {
		// Some servers send UTF-8 only once asked.
		if _, _, err := c.cmd(ctx, "OPTS UTF8 ON"); err != nil {
			return err
		}
	}
	if code, msg, err := c.cmd(ctx, "TYPE I"); err != nil {
		return err
	} else if code/100 != 2 {
		return &ServerError{Code: code, Msg: clean(msg)}
	}
	return nil
}

// startTLS upgrades the control connection.
func (c *ftpClient) startTLS(ctx context.Context) error {
	tc := tls.Client(c.conn, c.tlsCfg)
	hctx, cancel := context.WithTimeout(ctx, DialTimeout)
	defer cancel()
	if err := tc.HandshakeContext(hctx); err != nil {
		var ce *CertificateError
		if errors.As(err, &ce) {
			return ce
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// A server that answers the handshake with plain text has no TLS here.
		var rh tls.RecordHeaderError
		if errors.As(err, &rh) {
			return ErrTLSRequired
		}
		return err
	}
	c.conn = tc
	return nil
}

func (c *ftpClient) Features() Features { return c.feat }
func (c *ftpClient) Broken() bool       { return c.broken.Load() }

// guard bounds the I/O that follows on a connection by ctx and a timeout;
// cancelling ctx fails a read or write that is already blocked.
func guard(ctx context.Context, conn net.Conn, timeout time.Duration) (stop func()) {
	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	off := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	return func() {
		off()
		_ = conn.SetDeadline(time.Time{})
	}
}

// fail records an I/O error of the control connection: after one, the
// protocol's state is unknown and the connection is not used again.
func (c *ftpClient) fail(ctx context.Context, err error) error {
	c.broken.Store(true)
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}
	return err
}

// cmd sends one command and reads its reply.
func (c *ftpClient) cmd(ctx context.Context, format string, args ...any) (int, string, error) {
	if c.broken.Load() {
		return 0, "", ErrClosed
	}
	stop := guard(ctx, c.conn, CommandTimeout)
	defer stop()
	if err := c.text.PrintfLine(format, args...); err != nil {
		return 0, "", c.fail(ctx, err)
	}
	return c.readReply(ctx)
}

// reply reads a reply that no command of ours precedes (the greeting, the
// end of a transfer).
func (c *ftpClient) reply(ctx context.Context) (int, string, error) {
	stop := guard(ctx, c.conn, CommandTimeout)
	defer stop()
	return c.readReply(ctx)
}

func (c *ftpClient) readReply(ctx context.Context) (int, string, error) {
	code, msg, err := c.text.ReadResponse(0)
	if err != nil {
		var te *textproto.Error
		if !errors.As(err, &te) {
			return 0, "", c.fail(ctx, err)
		}
		code, msg = te.Code, te.Msg
	}
	return code, msg, nil
}

// clean makes a server's words safe to show.
func clean(msg string) string {
	msg = strings.ToValidUTF8(msg, "?")
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return strings.TrimSpace(msg)
}

// sendable reports whether s can be an argument: nothing in it ends the line.
func sendable(s string) bool {
	return !strings.ContainsAny(s, "\r\n\x00")
}

// arg encodes a path for the wire in the connection's encoding.
func (c *ftpClient) arg(path string) (string, error) {
	if !sendable(path) || path == "" {
		return "", ErrUnsafeName
	}
	if c.enc == nil {
		return path, nil
	}
	out, err := c.enc.NewEncoder().String(path)
	if err != nil || !sendable(out) {
		return "", ErrUnsafeName
	}
	return out, nil
}

// simple runs a command that is done when its reply is positive.
func (c *ftpClient) simple(ctx context.Context, format string, path string) error {
	a, err := c.arg(path)
	if err != nil {
		return err
	}
	code, msg, err := c.cmd(ctx, format, a)
	if err != nil {
		return err
	}
	return replyError(code, msg)
}

func replyError(code int, msg string) error {
	if code/100 == 2 || code/100 == 1 || code/100 == 3 {
		return nil
	}
	e := &ServerError{Code: code, Msg: clean(msg)}
	low := strings.ToLower(msg)
	if code == 550 && (strings.Contains(low, "no such") || strings.Contains(low, "not found") || strings.Contains(low, "not exist")) {
		return fmt.Errorf("%w: %w", ErrNotFound, e)
	}
	return e
}

func (c *ftpClient) Mkdir(ctx context.Context, path string) error {
	return c.simple(ctx, "MKD %s", path)
}
func (c *ftpClient) Delete(ctx context.Context, path string) error {
	return c.simple(ctx, "DELE %s", path)
}
func (c *ftpClient) Rmdir(ctx context.Context, path string) error {
	return c.simple(ctx, "RMD %s", path)
}

func (c *ftpClient) Rename(ctx context.Context, from, to string) error {
	if err := c.simple(ctx, "RNFR %s", from); err != nil {
		return err
	}
	return c.simple(ctx, "RNTO %s", to)
}

func (c *ftpClient) Size(ctx context.Context, path string) (int64, error) {
	a, err := c.arg(path)
	if err != nil {
		return 0, err
	}
	code, msg, err := c.cmd(ctx, "SIZE %s", a)
	if err != nil {
		return 0, err
	}
	if code != 213 {
		if err := replyError(code, msg); err != nil {
			return 0, err
		}
		return 0, ErrUnsupported
	}
	n, err := strconv.ParseInt(strings.TrimSpace(msg), 10, 64)
	if err != nil || n < 0 {
		return 0, ErrUnsupported
	}
	return n, nil
}

func (c *ftpClient) Noop(ctx context.Context) error {
	code, msg, err := c.cmd(ctx, "NOOP")
	if err != nil {
		return err
	}
	return replyError(code, msg)
}

func (c *ftpClient) Close() error {
	if !c.broken.Swap(true) && c.text != nil {
		// A polite goodbye, briefly; the socket closes either way.
		_ = c.conn.SetDeadline(time.Now().Add(2 * time.Second))
		_ = c.text.PrintfLine("QUIT")
	}
	return c.conn.Close()
}

// Data connections ---------------------------------------------------------------

// dataOpener yields the data connection of one transfer.
type dataOpener struct {
	conn     net.Conn     // passive: dialed before the command
	listener net.Listener // active: the server connects after the command
	peer     net.IP       // active: the only address allowed to connect
}

func (d *dataOpener) close() {
	if d.conn != nil {
		_ = d.conn.Close()
	}
	if d.listener != nil {
		_ = d.listener.Close()
	}
}

// open returns the connection: at once in passive mode; in active mode the
// server's, which must come from the server's own address.
func (d *dataOpener) open(ctx context.Context) (net.Conn, error) {
	if d.conn != nil {
		conn := d.conn
		d.conn = nil
		return conn, nil
	}
	if tl, ok := d.listener.(*net.TCPListener); ok {
		deadline := time.Now().Add(DialTimeout)
		if t, ok := ctx.Deadline(); ok && t.Before(deadline) {
			deadline = t
		}
		_ = tl.SetDeadline(deadline)
	}
	stop := context.AfterFunc(ctx, func() { _ = d.listener.Close() })
	defer stop()
	conn, err := d.listener.Accept()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	if ta, ok := conn.RemoteAddr().(*net.TCPAddr); !ok || !ta.IP.Equal(d.peer) {
		_ = conn.Close()
		return nil, errors.New("remote: a data connection came from another host")
	}
	return conn, nil
}

// prepare sets up the data connection of the next transfer command.
func (c *ftpClient) prepare(ctx context.Context) (*dataOpener, error) {
	if c.opts.Active {
		return c.prepareActive(ctx)
	}
	port := 0
	if !c.epsvOff {
		code, msg, err := c.cmd(ctx, "EPSV")
		if err != nil {
			return nil, err
		}
		if code == 229 {
			port = parseEPSV(msg)
		}
		if port == 0 {
			c.epsvOff = true
		}
	}
	if port == 0 {
		code, msg, err := c.cmd(ctx, "PASV")
		if err != nil {
			return nil, err
		}
		if code != 227 {
			return nil, replyError(code, msg)
		}
		// Only the port is taken from the reply. The address in it is ignored:
		// data goes to the host the control connection is on, whatever the
		// server (or someone in between) says.
		if port = parsePASV(msg); port == 0 {
			return nil, &ServerError{Code: code, Msg: "the server's PASV reply could not be read"}
		}
	}
	dctx, cancel := context.WithTimeout(ctx, DialTimeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(dctx, "tcp", net.JoinHostPort(c.host, strconv.Itoa(port)))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	return &dataOpener{conn: conn}, nil
}

func (c *ftpClient) prepareActive(ctx context.Context) (*dataOpener, error) {
	local, lok := c.conn.LocalAddr().(*net.TCPAddr)
	peer, pok := c.conn.RemoteAddr().(*net.TCPAddr)
	if !lok || !pok {
		return nil, ErrUnsupported
	}
	l, err := net.ListenTCP("tcp", &net.TCPAddr{IP: local.IP})
	if err != nil {
		return nil, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	var line string
	if ip4 := local.IP.To4(); ip4 != nil {
		line = fmt.Sprintf("PORT %d,%d,%d,%d,%d,%d", ip4[0], ip4[1], ip4[2], ip4[3], port>>8, port&0xff)
	} else {
		line = fmt.Sprintf("EPRT |2|%s|%d|", local.IP.String(), port)
	}
	code, msg, err := c.cmd(ctx, "%s", line)
	if err == nil {
		err = replyError(code, msg)
	}
	if err != nil {
		_ = l.Close()
		return nil, err
	}
	return &dataOpener{listener: l, peer: peer.IP}, nil
}

// parseEPSV reads "Entering Extended Passive Mode (|||50001|)"; 0 = unreadable.
func parseEPSV(msg string) int {
	i, j := strings.LastIndex(msg, "("), strings.LastIndex(msg, ")")
	if i < 0 || j < i+6 {
		return 0
	}
	body := msg[i+1 : j]
	d := body[:1]
	parts := strings.Split(body, d)
	if len(parts) != 5 {
		return 0
	}
	port, err := strconv.Atoi(parts[3])
	if err != nil || port < 1 || port > 65535 {
		return 0
	}
	return port
}

// parsePASV reads the port of "Entering Passive Mode (h1,h2,h3,h4,p1,p2)".
func parsePASV(msg string) int {
	i, j := strings.Index(msg, "("), strings.LastIndex(msg, ")")
	if i < 0 || j < i {
		// Some servers leave the parentheses out.
		i = strings.IndexFunc(msg, func(r rune) bool { return r >= '0' && r <= '9' }) - 1
		j = len(msg)
		if i < -1 {
			return 0
		}
	}
	parts := strings.Split(strings.TrimRight(strings.TrimSpace(msg[i+1:j]), "."), ",")
	if len(parts) != 6 {
		return 0
	}
	hi, err1 := strconv.Atoi(strings.TrimSpace(parts[4]))
	lo, err2 := strconv.Atoi(strings.TrimSpace(parts[5]))
	if err1 != nil || err2 != nil || hi < 0 || hi > 255 || lo < 0 || lo > 255 {
		return 0
	}
	return hi<<8 | lo
}

// transfer runs one command with a data connection: REST when it continues,
// the command, the data, then the server's verdict.
func (c *ftpClient) transfer(ctx context.Context, line string, offset int64, use func(data net.Conn) error) error {
	opener, err := c.prepare(ctx)
	if err != nil {
		return err
	}
	defer opener.close()
	if offset > 0 {
		if !c.feat.Resume {
			return ErrUnsupported
		}
		code, msg, err := c.cmd(ctx, "REST %d", offset)
		if err != nil {
			return err
		}
		if code != 350 {
			return replyError(code, msg)
		}
	}
	code, msg, err := c.cmd(ctx, "%s", line)
	if err != nil {
		return err
	}
	if code/100 != 1 {
		if err := replyError(code, msg); err != nil {
			return err
		}
		return &ServerError{Code: code, Msg: clean(msg)}
	}
	data, err := opener.open(ctx)
	if err != nil {
		// The server waits for a connection that will not come.
		c.broken.Store(true)
		return err
	}
	if c.tlsCfg != nil {
		data = tls.Client(data, c.tlsCfg)
	}
	uerr := use(data)
	cerr := data.Close()
	if uerr != nil {
		// Cut off (cancelled, stalled, a local write failed): the server still
		// answers the transfer; if it does not, the connection is done for.
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), abortWait)
		defer cancel()
		if _, _, rerr := c.reply(rctx); rerr != nil {
			c.broken.Store(true)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return uerr
	}
	code, msg, err = c.reply(ctx)
	if err != nil {
		return err
	}
	if code/100 != 2 {
		return replyError(code, msg)
	}
	// A TLS close that failed after a complete transfer is not an error.
	_ = cerr
	return nil
}

// idle refreshes a data connection's deadline: a transfer may take long,
// but it may not stand still.
type idle struct {
	conn net.Conn
}

func (i idle) Read(p []byte) (int, error) {
	_ = i.conn.SetReadDeadline(time.Now().Add(DataIdle))
	return i.conn.Read(p)
}

func (i idle) Write(p []byte) (int, error) {
	_ = i.conn.SetWriteDeadline(time.Now().Add(DataIdle))
	return i.conn.Write(p)
}

// copyData copies with a pooled buffer, stopping when ctx is cancelled.
func copyData(ctx context.Context, data net.Conn, dst io.Writer, src io.Reader) error {
	stop := context.AfterFunc(ctx, func() { _ = data.SetDeadline(time.Unix(1, 0)) })
	defer stop()
	buf := transferPool.Get().(*[]byte)
	defer transferPool.Put(buf)
	_, err := io.CopyBuffer(dst, src, *buf)
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}
	return err
}

func (c *ftpClient) Retrieve(ctx context.Context, path string, offset int64, w io.Writer) error {
	a, err := c.arg(path)
	if err != nil {
		return err
	}
	return c.transfer(ctx, "RETR "+a, offset, func(data net.Conn) error {
		// Only the reader: io.Copy must not hand the socket to w.
		return copyData(ctx, data, w, struct{ io.Reader }{idle{data}})
	})
}

func (c *ftpClient) Store(ctx context.Context, path string, offset int64, r io.Reader) error {
	a, err := c.arg(path)
	if err != nil {
		return err
	}
	return c.transfer(ctx, "STOR "+a, offset, func(data net.Conn) error {
		return copyData(ctx, data, struct{ io.Writer }{idle{data}}, r)
	})
}

func (c *ftpClient) List(ctx context.Context, dir string) ([]Entry, int, error) {
	a, err := c.arg(dir)
	if err != nil {
		return nil, 0, err
	}
	line := "MLSD " + a
	if !c.feat.MLSD {
		// LIST takes no reliable path argument next to its flags: go there first.
		code, msg, err := c.cmd(ctx, "CWD %s", a)
		if err != nil {
			return nil, 0, err
		}
		if err := replyError(code, msg); err != nil {
			return nil, 0, err
		}
		line = "LIST -a"
		if c.listPlain {
			line = "LIST"
		}
	}
	var entries []Entry
	rejected := 0
	read := func(data net.Conn) error {
		entries, rejected = entries[:0], 0
		stop := context.AfterFunc(ctx, func() { _ = data.SetDeadline(time.Unix(1, 0)) })
		defer stop()
		sc := bufio.NewScanner(idle{data})
		sc.Buffer(make([]byte, 0, 64<<10), maxListLine)
		var dec *encoding.Decoder
		if c.enc != nil {
			dec = c.enc.NewDecoder()
		}
		now := c.now()
		for sc.Scan() {
			raw := sc.Bytes()
			text := string(raw)
			if dec != nil {
				b, err := dec.Bytes(raw)
				if err != nil {
					rejected++
					continue
				}
				text = string(b)
			}
			var e Entry
			var ok bool
			if c.feat.MLSD {
				e, ok = parseMLSD(strings.TrimRight(text, "\r"))
			} else {
				e, ok = parseLIST(text, now)
			}
			if !ok {
				continue
			}
			if e.Name == "." || e.Name == ".." {
				continue
			}
			if !SafeName(e.Name) {
				rejected++
				continue
			}
			if len(entries) == MaxDirEntries {
				return ErrTooLarge
			}
			entries = append(entries, e)
		}
		if err := sc.Err(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// A line beyond the limit is a name that cannot be listed.
			if errors.Is(err, bufio.ErrTooLong) {
				return fmt.Errorf("%w: a line of the listing is too long", ErrUnsafeName)
			}
			return err
		}
		return nil
	}
	err = c.transfer(ctx, line, 0, read)
	// A server without "-a": once more, plainly.
	var se *ServerError
	if err != nil && !c.feat.MLSD && !c.listPlain && errors.As(err, &se) && se.Code/100 == 5 {
		c.listPlain = true
		err = c.transfer(ctx, "LIST", 0, read)
	}
	if err != nil {
		return nil, 0, err
	}
	return entries, rejected, nil
}
