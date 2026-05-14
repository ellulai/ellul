// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Transparent TCP Proxy for tunnel_guard mode
//
// Handles iptables REDIRECT transparently: gets original destination via
// SO_ORIGINAL_DST, extracts domain from TLS SNI or HTTP Host header,
// blocks tunnel/mining domains, and forwards everything else.
//
// No MITM or certificate generation needed — just domain-level blocking
// with raw TCP splicing for allowed connections.

package proxy

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const SO_ORIGINAL_DST = 80

// TransparentProxy handles transparent TCP proxying via iptables REDIRECT.
// It extracts domains from TLS SNI / HTTP Host headers and blocks
// known-bad destinations (tunnel services, crypto mining).
type TransparentProxy struct {
	config  Config
	rules   *Rules
	running bool
	blocked int64
	allowed int64
}

// NewTransparent creates a transparent proxy for tunnel_guard mode.
func NewTransparent(config Config) (*TransparentProxy, error) {
	return &TransparentProxy{
		config: config,
		rules:  config.Rules,
	}, nil
}

// Start listens for redirected connections and proxies them.
func (p *TransparentProxy) Start() error {
	addr := fmt.Sprintf(":%d", p.config.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("transparent proxy listen: %w", err)
	}

	p.running = true
	log.Printf("[warden] Transparent proxy listening on %s", addr)

	for {
		conn, err := ln.Accept()
		if err != nil {
			if p.running {
				log.Printf("[warden-transparent] Accept error: %v", err)
			}
			return err
		}
		go p.handleConn(conn)
	}
}

func (p *TransparentProxy) handleConn(clientConn net.Conn) {
	defer clientConn.Close()

	tcpConn, ok := clientConn.(*net.TCPConn)
	if !ok {
		return
	}

	// Get the original destination before iptables REDIRECT
	origIP, origPort, err := getOriginalDst(tcpConn)
	if err != nil {
		log.Printf("[warden-transparent] Failed to get original dst: %v", err)
		return
	}

	origAddr := fmt.Sprintf("%s:%d", origIP, origPort)

	// Peek at first bytes to extract domain name
	peekBuf := make([]byte, 4096)
	tcpConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := tcpConn.Read(peekBuf)
	tcpConn.SetReadDeadline(time.Time{})
	if err != nil || n == 0 {
		return
	}
	peek := peekBuf[:n]

	var domain string
	if len(peek) > 0 && peek[0] == 0x16 {
		// TLS ClientHello — extract SNI
		domain = extractSNI(peek)
	} else {
		// Might be HTTP — extract Host header
		domain = extractHTTPHost(peek)
	}

	// Check if domain should be blocked
	if domain != "" {
		hostname := domain
		if idx := strings.LastIndex(hostname, ":"); idx != -1 {
			hostname = hostname[:idx]
		}

		if p.rules.isBlacklisted(hostname) || p.rules.IsTunnelDomain(hostname) {
			atomic.AddInt64(&p.blocked, 1)
			log.Printf("[warden-transparent] BLOCKED %s (domain: %s)", origAddr, hostname)
			return
		}
	}

	atomic.AddInt64(&p.allowed, 1)

	// Connect to original destination
	serverConn, err := net.DialTimeout("tcp", origAddr, 10*time.Second)
	if err != nil {
		log.Printf("[warden-transparent] Dial failed %s: %v", origAddr, err)
		return
	}
	defer serverConn.Close()

	// Send the peeked data to server
	if _, err := serverConn.Write(peek); err != nil {
		return
	}

	// Splice connections bidirectionally
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		io.Copy(serverConn, clientConn)
		if tc, ok := serverConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		io.Copy(clientConn, serverConn)
		tcpConn.CloseWrite()
	}()
	wg.Wait()
}

// getOriginalDst retrieves the original destination address from iptables REDIRECT.
func getOriginalDst(conn *net.TCPConn) (string, uint16, error) {
	rawConn, err := conn.SyscallConn()
	if err != nil {
		return "", 0, err
	}

	var addr syscall.RawSockaddrInet4
	var getsockoptErr error

	err = rawConn.Control(func(fd uintptr) {
		size := uint32(unsafe.Sizeof(addr))
		_, _, errno := syscall.Syscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			syscall.SOL_IP,
			SO_ORIGINAL_DST,
			uintptr(unsafe.Pointer(&addr)),
			uintptr(unsafe.Pointer(&size)),
			0,
		)
		if errno != 0 {
			getsockoptErr = fmt.Errorf("getsockopt SO_ORIGINAL_DST: %v", errno)
		}
	})
	if err != nil {
		return "", 0, err
	}
	if getsockoptErr != nil {
		return "", 0, getsockoptErr
	}

	ip := net.IPv4(addr.Addr[0], addr.Addr[1], addr.Addr[2], addr.Addr[3])
	port := binary.BigEndian.Uint16((*[2]byte)(unsafe.Pointer(&addr.Port))[:])

	return ip.String(), port, nil
}

// extractSNI parses TLS ClientHello to extract the Server Name Indication.
func extractSNI(data []byte) string {
	// TLS record: type(1) + version(2) + length(2) + handshake
	if len(data) < 5 || data[0] != 0x16 {
		return ""
	}

	recordLen := int(binary.BigEndian.Uint16(data[3:5]))
	end := 5 + recordLen
	if end > len(data) {
		end = len(data)
	}
	handshake := data[5:end]

	// Handshake: type(1) + length(3) + ClientHello
	if len(handshake) < 4 || handshake[0] != 0x01 {
		return ""
	}

	helloLen := int(handshake[1])<<16 | int(handshake[2])<<8 | int(handshake[3])
	helloEnd := 4 + helloLen
	if helloEnd > len(handshake) {
		helloEnd = len(handshake)
	}
	hello := handshake[4:helloEnd]

	// ClientHello: version(2) + random(32) + session_id + cipher_suites + compression + extensions
	if len(hello) < 34 {
		return ""
	}
	pos := 34 // skip version + random

	// Session ID (variable length)
	if pos >= len(hello) {
		return ""
	}
	sessionIDLen := int(hello[pos])
	pos += 1 + sessionIDLen

	// Cipher suites (2-byte length + data)
	if pos+2 > len(hello) {
		return ""
	}
	cipherLen := int(binary.BigEndian.Uint16(hello[pos:]))
	pos += 2 + cipherLen

	// Compression methods (1-byte length + data)
	if pos >= len(hello) {
		return ""
	}
	compLen := int(hello[pos])
	pos += 1 + compLen

	// Extensions (2-byte length + data)
	if pos+2 > len(hello) {
		return ""
	}
	extLen := int(binary.BigEndian.Uint16(hello[pos:]))
	pos += 2
	extEnd := pos + extLen
	if extEnd > len(hello) {
		extEnd = len(hello)
	}

	// Walk extensions looking for SNI (type 0x0000)
	for pos+4 <= extEnd {
		extType := binary.BigEndian.Uint16(hello[pos:])
		extDataLen := int(binary.BigEndian.Uint16(hello[pos+2:]))
		pos += 4

		if extType == 0x0000 && pos+extDataLen <= extEnd {
			// SNI extension: list_length(2) + entries
			sniData := hello[pos : pos+extDataLen]
			if len(sniData) < 5 {
				break
			}
			// Skip list length (2 bytes), read first entry
			nameType := sniData[2]
			nameLen := int(binary.BigEndian.Uint16(sniData[3:5]))
			if nameType == 0 && 5+nameLen <= len(sniData) {
				return string(sniData[5 : 5+nameLen])
			}
		}
		pos += extDataLen
	}

	return ""
}

// extractHTTPHost extracts the Host header from an HTTP request.
func extractHTTPHost(data []byte) string {
	s := string(data)
	lines := strings.Split(s, "\r\n")
	for _, line := range lines[1:] {
		if line == "" {
			break
		}
		if len(line) > 5 && strings.EqualFold(line[:5], "host:") {
			return strings.TrimSpace(line[5:])
		}
	}
	return ""
}

// IsRunning returns whether the proxy is active.
func (p *TransparentProxy) IsRunning() bool {
	return p.running
}

// Stats returns proxy statistics.
func (p *TransparentProxy) Stats() (allowed, blocked int64) {
	return atomic.LoadInt64(&p.allowed), atomic.LoadInt64(&p.blocked)
}
