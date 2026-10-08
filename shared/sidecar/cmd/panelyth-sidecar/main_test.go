package main

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"panelyth/sidecar/internal/rpc"
)

// TestMain lets the test binary act as the sidecar when re-executed, so the
// process-level behaviour (stdout discipline, exit codes, EOF shutdown) is
// tested against the real entrypoint.
func TestMain(m *testing.M) {
	if os.Getenv("PANELYTH_SIDECAR_UNDER_TEST") == "1" {
		os.Args = []string{os.Args[0], "-log-level", "debug"}
		os.Exit(run())
	}
	os.Exit(m.Run())
}

type proc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	frames *rpc.FrameReader
	exited chan error
}

func startSidecar(t *testing.T) *proc {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(),
		"PANELYTH_SIDECAR_UNDER_TEST=1",
		"PANELYTH_CACHE_DIR="+t.TempDir(),
		"PANELYTH_CONFIG_DIR="+t.TempDir(),
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &proc{cmd: cmd, stdin: stdin, frames: rpc.NewFrameReader(stdout), exited: make(chan error, 1)}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	hello := p.read(t)
	if hello["t"] != "hello" || hello["protocol"] != float64(rpc.ProtocolVersion) {
		t.Fatalf("bad hello: %v", hello)
	}
	return p
}

func (p *proc) read(t *testing.T) map[string]any {
	t.Helper()
	payload, err := p.frames.ReadFrame()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatalf("stdout carried a non-JSON frame: %v", err)
	}
	return m
}

func (p *proc) send(t *testing.T, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := rpc.WriteFrame(p.stdin, b); err != nil {
		t.Fatal(err)
	}
}

func (p *proc) wait(t *testing.T, within time.Duration) int {
	t.Helper()
	go func() { p.exited <- p.cmd.Wait() }()
	select {
	case <-p.exited:
		return p.cmd.ProcessState.ExitCode()
	case <-time.After(within):
		t.Fatalf("sidecar did not exit within %v", within)
	}
	return -1
}

func TestPingThenExitOnStdinEOF(t *testing.T) {
	p := startSidecar(t)
	p.send(t, map[string]any{"t": "req", "id": 1, "m": "system.ping", "p": map[string]any{}})
	res := p.read(t)
	if res["ok"] != true || res["r"].(map[string]any)["pong"] != true {
		t.Fatalf("bad ping response: %v", res)
	}
	_ = p.stdin.Close()
	if code := p.wait(t, 3*time.Second); code != 0 {
		t.Fatalf("exit code %d, want 0", code)
	}
}

func TestShutdownRequest(t *testing.T) {
	p := startSidecar(t)
	p.send(t, map[string]any{"t": "req", "id": 1, "m": "system.shutdown", "p": map[string]any{}})
	res := p.read(t)
	if res["ok"] != true || res["r"].(map[string]any)["accepted"] != true {
		t.Fatalf("bad shutdown response: %v", res)
	}
	if code := p.wait(t, 3*time.Second); code != 0 {
		t.Fatalf("exit code %d, want 0", code)
	}
}

func TestDevMethodsDisabledByDefault(t *testing.T) {
	p := startSidecar(t)
	p.send(t, map[string]any{"t": "req", "id": 1, "m": "system.echo", "p": map[string]any{"payload": "x"}})
	res := p.read(t)
	if e, _ := res["e"].(map[string]any); e["code"] != "METHOD_NOT_FOUND" {
		t.Fatalf("system.echo must not exist without PANELYTH_DEV_METHODS: %v", res)
	}
}
