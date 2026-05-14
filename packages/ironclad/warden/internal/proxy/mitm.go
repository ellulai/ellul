// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// MITM Proxy — Hotel California enforcement
//
// Hybrid listener that handles two connection types on one port:
//
//   Forward proxy   (proxy-aware clients send HTTP CONNECT)
//     → goproxy MITM → full HTTP method inspection
//
//   Transparent proxy (iptables REDIRECT sends raw TLS)
//     → SO_ORIGINAL_DST → SNI → CA-signed cert → TLS handshake
//     → httputil.ReverseProxy → full HTTP method inspection
//
// Both paths share the same Rules engine, cert CA, and bandwidth policy.
//
// Security invariants preserved from the forward-only proxy:
//   - Same Rules.Evaluate on every decrypted HTTP request (method + content-type + URL length)
//   - Same blacklist + tunnel domain checks at CONNECT / SNI stage
//   - Same bandwidth throttle on server→client bytes
//   - Loop guard: reject origAddr == listen address (prevents proxy→self DoS)
//   - Cert store cap: 10 000 entries max (prevents memory exhaustion via SNI flooding)

package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/elazarl/goproxy"
)

// Config holds proxy configuration.
type Config struct {
	Port        int
	CAKeyFile   string
	CACertFile  string
	Rules       *Rules
	BandwidthKB int
}

// Proxy is the Hotel California MITM proxy.
type Proxy struct {
	config  Config
	server  *goproxy.ProxyHttpServer
	rules   *Rules
	certs   *certStore
	running int32
	blocked int64
	allowed int64
}

// New creates a new Hotel California proxy.
func New(config Config) (*Proxy, error) {
	server := goproxy.NewProxyHttpServer()
	server.Verbose = false

	// Load CA for both forward proxy (goproxy) and transparent proxy (certStore)
	caCert, err := tls.LoadX509KeyPair(config.CACertFile, config.CAKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load CA keypair: %w", err)
	}

	caX509, err := x509.ParseCertificate(caCert.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse CA cert: %w", err)
	}

	goproxy.GoproxyCa = caCert

	p := &Proxy{
		config: config,
		server: server,
		rules:  config.Rules,
		certs:  newCertStore(caCert, caX509),
	}

	// --- Forward proxy handlers (goproxy) ---

	server.OnRequest().HandleConnectFunc(func(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
		hostname := stripPort(host)
		if p.rules.isBlacklisted(hostname) || p.rules.IsTunnelDomain(hostname) {
			atomic.AddInt64(&p.blocked, 1)
			log.Printf("[warden] CONNECT REJECTED: %s", host)
			return goproxy.RejectConnect, host
		}
		return goproxy.MitmConnect, host
	})

	server.OnRequest().DoFunc(func(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		return p.enforceRules(req)
	})

	return p, nil
}

// Start listens for connections and dispatches by protocol.
func (p *Proxy) Start() error {
	addr := fmt.Sprintf(":%d", p.config.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}

	atomic.StoreInt32(&p.running, 1)
	log.Printf("[warden] MITM proxy on %s (forward + transparent)", addr)

	// goproxy reads from a channel-fed listener
	httpLn := newChanListener(ln.Addr())
	go http.Serve(httpLn, p.server) //nolint:errcheck

	// Background cert cache cleanup
	go p.certs.janitor()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if atomic.LoadInt32(&p.running) == 1 {
				log.Printf("[warden] accept: %v", err)
			}
			return err
		}
		go p.dispatch(conn, httpLn)
	}
}

// dispatch peeks at the first byte: 0x16 = TLS (transparent), else HTTP (forward proxy).
func (p *Proxy) dispatch(raw net.Conn, httpLn *chanListener) {
	raw.SetReadDeadline(time.Now().Add(10 * time.Second))

	br := bufio.NewReaderSize(raw, 16384)
	first, err := br.Peek(1)
	raw.SetReadDeadline(time.Time{})

	if err != nil {
		raw.Close()
		return
	}

	conn := &bufferedConn{Reader: br, Conn: raw}

	if first[0] == 0x16 {
		p.handleTransparent(conn)
	} else {
		httpLn.send(conn)
	}
}

// handleTransparent does transparent MITM for a single client connection:
//
//  1. Recover original destination via SO_ORIGINAL_DST
//  2. Loop guard — reject if origAddr == our listen address
//  3. Extract SNI from the (peeked, not consumed) ClientHello
//  4. Domain-level block check
//  5. Generate CA-signed leaf cert, TLS handshake with client
//  6. Serve HTTP on the decrypted stream via httputil.ReverseProxy
//     with the same Rules engine as the forward proxy path
func (p *Proxy) handleTransparent(conn *bufferedConn) {
	defer conn.Close()

	tcp, ok := conn.Conn.(*net.TCPConn)
	if !ok {
		return
	}

	origIP, origPort, err := getOriginalDst(tcp)
	if err != nil {
		log.Printf("[warden-tp] original dst: %v", err)
		return
	}

	// Loop guard: if the original destination is our own proxy port on
	// localhost, the connection is either a direct probe or an iptables
	// REDIRECT that didn't change the destination (already port 8080).
	// Forwarding this would create an infinite proxy→self loop.
	if isLoopback(origIP) && origPort == uint16(p.config.Port) {
		log.Printf("[warden-tp] loop guard: dropping connection to self (%s:%d)", origIP, origPort)
		return
	}

	origAddr := net.JoinHostPort(origIP, fmt.Sprintf("%d", origPort))

	// Peek enough for SNI extraction — Peek fills the buffer without consuming.
	conn.Conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	hello, _ := conn.Reader.Peek(4096)
	conn.Conn.SetReadDeadline(time.Time{})

	if len(hello) < 5 {
		return
	}

	sni := extractSNI(hello)
	if sni == "" {
		sni = origIP
	}

	hostname := stripPort(sni)
	if p.rules.isBlacklisted(hostname) || p.rules.IsTunnelDomain(hostname) {
		atomic.AddInt64(&p.blocked, 1)
		log.Printf("[warden-tp] BLOCKED %s (%s)", sni, origAddr)
		return
	}

	leaf, err := p.certs.get(sni)
	if err != nil {
		log.Printf("[warden-tp] cert for %s: %v", sni, err)
		return
	}

	tlsConn := tls.Server(conn, &tls.Config{
		Certificates: []tls.Certificate{*leaf},
	})
	if err := tlsConn.Handshake(); err != nil {
		return // client doesn't trust our CA — nothing we can do
	}

	// Build a per-connection reverse proxy that dials the original destination.
	transport := p.makeTransport(sni, origAddr)
	defer transport.CloseIdleConnections()

	rp := &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			r.URL.Scheme = "https"
			r.URL.Host = sni
			r.Host = sni
		},
		Transport:  transport,
		BufferPool: bpool,
		ErrorLog:   log.New(io.Discard, "", 0),
	}

	// Serve HTTP on the decrypted TLS stream, enforcing rules per-request.
	// ConnState callback detects when the connection is fully done so we
	// can unblock srv.Serve (which otherwise hangs on the second Accept).
	connDone := make(chan struct{})
	var connDoneOnce sync.Once

	srv := &http.Server{
		Handler:     p.transparentHandler(rp, sni),
		IdleTimeout: 60 * time.Second,
		ErrorLog:    log.New(io.Discard, "", 0),
		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateClosed || state == http.StateHijacked {
				connDoneOnce.Do(func() { close(connDone) })
			}
		},
	}

	// singleListener yields tlsConn once, then blocks until Close().
	ln := newSingleListener(tlsConn)

	go srv.Serve(ln) //nolint:errcheck

	// Wait for the HTTP handler goroutine to finish with the connection,
	// then tear down the listener so srv.Serve returns cleanly.
	<-connDone
	ln.Close()

	// Graceful shutdown drains any in-flight response writes.
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutCancel()
	srv.Shutdown(shutCtx)
}

// makeTransport returns an http.RoundTripper that always dials origAddr
// (the pre-REDIRECT destination) with SNI set to sni. Bandwidth-throttled
// if configured.
func (p *Proxy) makeTransport(sni, origAddr string) *http.Transport {
	t := &http.Transport{
		DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := &net.Dialer{Timeout: 15 * time.Second}
			return tls.DialWithDialer(d, "tcp", origAddr, &tls.Config{
				ServerName: sni,
			})
		},
		MaxIdleConns:        1,
		IdleConnTimeout:     60 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		DisableCompression:  true,
	}

	// Bandwidth throttling — same policy as forward proxy path
	if p.config.BandwidthKB > 0 {
		t.DialTLSContext = wrapDialThrottle(t.DialTLSContext, p.config.BandwidthKB)
	}

	return t
}

// transparentHandler returns an http.Handler that applies Hotel California
// rules before forwarding to the reverse proxy.
func (p *Proxy) transparentHandler(rp *httputil.ReverseProxy, sni string) http.Handler {
	blockMsg := "Hotel California: you can check out any time you like, but your code can never leave.\n" +
		"Upgrade to a paid plan for full network access.\n"
	if p.rules.Mode == "tunnel_guard" {
		blockMsg = "Tunnel services are blocked on dev tiers.\n" +
			"Upgrade to a hosting plan for public port access.\n"
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Scheme = "https"
		r.URL.Host = sni
		r.Host = sni

		if p.rules.Evaluate(r) == Block {
			atomic.AddInt64(&p.blocked, 1)
			log.Printf("[warden-tp] BLOCKED %s https://%s%s (ct: %s)",
				r.Method, sni, r.URL.Path, r.Header.Get("Content-Type"))
			http.Error(w, blockMsg, http.StatusForbidden)
			return
		}

		atomic.AddInt64(&p.allowed, 1)
		rp.ServeHTTP(w, r)
	})
}

// enforceRules evaluates the request against Hotel California rules.
// Used by the forward proxy (goproxy) path. Returns (req, nil) on allow,
// or (req, response) on block.
func (p *Proxy) enforceRules(req *http.Request) (*http.Request, *http.Response) {
	verdict := p.rules.Evaluate(req)
	if verdict == Block {
		atomic.AddInt64(&p.blocked, 1)
		log.Printf("[warden] BLOCKED %s %s://%s%s (ct: %s)",
			req.Method, req.URL.Scheme, req.URL.Host, req.URL.Path,
			req.Header.Get("Content-Type"))

		msg := "Hotel California: you can check out any time you like, but your code can never leave.\n" +
			"Upgrade to a paid plan for full network access.\n"
		if p.rules.Mode == "tunnel_guard" {
			msg = "Tunnel services are blocked on dev tiers.\n" +
				"Upgrade to a hosting plan for public port access.\n"
		}
		return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusForbidden, msg)
	}

	atomic.AddInt64(&p.allowed, 1)
	return req, nil
}

func (p *Proxy) IsRunning() bool { return atomic.LoadInt32(&p.running) == 1 }
func (p *Proxy) Stats() (int64, int64) {
	return atomic.LoadInt64(&p.allowed), atomic.LoadInt64(&p.blocked)
}

// ────────────────────────────────────────────
// Infrastructure
// ────────────────────────────────────────────

// chanListener feeds accepted connections to goproxy's http.Server.
type chanListener struct {
	ch   chan net.Conn
	addr net.Addr
}

func newChanListener(addr net.Addr) *chanListener {
	return &chanListener{ch: make(chan net.Conn, 256), addr: addr}
}
func (l *chanListener) send(c net.Conn) { l.ch <- c }
func (l *chanListener) Accept() (net.Conn, error) {
	c, ok := <-l.ch
	if !ok {
		return nil, net.ErrClosed
	}
	return c, nil
}
func (l *chanListener) Close() error   { close(l.ch); return nil }
func (l *chanListener) Addr() net.Addr { return l.addr }

// singleListener yields one connection, then blocks until Close() is called.
// Used to feed a single TLS connection into an http.Server for transparent MITM.
type singleListener struct {
	conn   net.Conn
	once   sync.Once
	closed chan struct{}
}

func newSingleListener(c net.Conn) *singleListener {
	return &singleListener{conn: c, closed: make(chan struct{})}
}

func (l *singleListener) Accept() (net.Conn, error) {
	var c net.Conn
	l.once.Do(func() { c = l.conn })
	if c != nil {
		return c, nil
	}
	// Block until Close() signals shutdown — prevents Serve from spinning.
	<-l.closed
	return nil, net.ErrClosed
}

func (l *singleListener) Close() error {
	select {
	case <-l.closed:
	default:
		close(l.closed)
	}
	return nil
}

func (l *singleListener) Addr() net.Addr { return l.conn.LocalAddr() }

// bufferedConn wraps a net.Conn with a bufio.Reader so we can Peek
// at the protocol byte without consuming it. tls.Server / http.Server
// read through the bufio.Reader, which replays buffered data first.
type bufferedConn struct {
	*bufio.Reader
	net.Conn
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.Reader.Read(b) }

// isLoopback returns true if the IP string is a loopback address.
func isLoopback(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.IsLoopback()
}

// stripPort removes the :port suffix if present.
func stripPort(hostport string) string {
	if i := strings.LastIndex(hostport, ":"); i != -1 {
		return hostport[:i]
	}
	return hostport
}

// bufferPool avoids per-request allocations in httputil.ReverseProxy.
var bpool = &syncPool{}

type syncPool struct{ pool sync.Pool }

func (p *syncPool) Get() []byte {
	if v := p.pool.Get(); v != nil {
		return v.([]byte)
	}
	return make([]byte, 32*1024)
}
func (p *syncPool) Put(b []byte) { p.pool.Put(b) }

// wrapDialThrottle returns a DialTLSContext that wraps the returned connection
// with bandwidth throttling (applied to reads = download direction).
func wrapDialThrottle(
	base func(ctx context.Context, network, addr string) (net.Conn, error),
	kbPerSecond int,
) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := base(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return &throttledConn{Conn: c, rateBytes: int64(kbPerSecond) * 1024}, nil
	}
}

// throttledConn rate-limits reads (server→client direction = download).
type throttledConn struct {
	net.Conn
	rateBytes int64
	bytesRead int64
	startTime time.Time
	once      sync.Once
}

func (c *throttledConn) Read(b []byte) (int, error) {
	c.once.Do(func() { c.startTime = time.Now() })
	n, err := c.Conn.Read(b)
	c.bytesRead += int64(n)

	expected := time.Duration(float64(c.bytesRead) / float64(c.rateBytes) * float64(time.Second))
	elapsed := time.Since(c.startTime)
	if expected > elapsed {
		time.Sleep(expected - elapsed)
	}

	return n, err
}
