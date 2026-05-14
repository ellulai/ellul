// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Forwarding DNS Resolver with Blacklist
//
// Runs on :5353, forwards all queries to upstream (Cloudflare 1.1.1.1)
// except for blacklisted domains which return NXDOMAIN.
//
// Also blocks DNS tunneling via:
// - TXT/NULL query type blocking
// - Entropy detection on subdomain labels
// - Per-source rate limiting (50 queries / 10s)

package dns

import (
	"fmt"
	"log"
	"math"
	"net"
	"strings"
	"sync"
	"time"
)

// dnsRateLimiter tracks query rates per source IP using a sliding window.
// Prevents DNS tunneling via high-volume queries (e.g., encoding data
// one byte per query label across thousands of queries).
type dnsRateLimiter struct {
	mu       sync.Mutex
	counters map[string]*rateBucket
	limit    int           // max queries per window
	window   time.Duration // sliding window duration
}

type rateBucket struct {
	count    int
	windowStart time.Time
}

func newDNSRateLimiter(limit int, window time.Duration) *dnsRateLimiter {
	return &dnsRateLimiter{
		counters: make(map[string]*rateBucket),
		limit:    limit,
		window:   window,
	}
}

// allow checks if a source IP is within the rate limit.
func (rl *dnsRateLimiter) allow(src string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	bucket, exists := rl.counters[src]

	if !exists || now.Sub(bucket.windowStart) > rl.window {
		// New window
		rl.counters[src] = &rateBucket{count: 1, windowStart: now}
		return true
	}

	bucket.count++
	return bucket.count <= rl.limit
}

// Resolver is a forwarding DNS resolver with blacklist.
type Resolver struct {
	port      int
	upstream  string
	blacklist map[string]bool
	running   bool
	limiter   *dnsRateLimiter
}

// NewResolver creates a new DNS resolver in hotel_california mode (free tier).
func NewResolver(port int) *Resolver {
	return NewResolverWithMode(port, "hotel_california")
}

// NewResolverWithMode creates a DNS resolver with the specified enforcement mode.
//
// Modes:
//   - "hotel_california": Full blacklist (tunnels + mining + cloud APIs). Rate limit: 50 q/10s.
//   - "tunnel_guard": Tunnel + mining blacklist only (cloud APIs allowed). Rate limit: 200 q/10s.
func NewResolverWithMode(port int, mode string) *Resolver {
	blacklist := fullBlacklist()
	rateLimit := 50

	if mode == "tunnel_guard" {
		blacklist = tunnelOnlyBlacklist()
		rateLimit = 200
	}

	return &Resolver{
		port:      port,
		upstream:  "1.1.1.1:53",
		limiter:   newDNSRateLimiter(rateLimit, 10*time.Second),
		blacklist: blacklist,
		running:   false,
	}
}

// fullBlacklist returns the complete blacklist for hotel_california mode (free tier).
// Blocks tunnels, mining, cloud deploy APIs, container registries, and C2.
func fullBlacklist() map[string]bool {
	return map[string]bool{
		// === Crypto mining pools ===
		"pool.minergate.com":      true,
		"xmr.pool.minergate.com":  true,
		"moneroocean.stream":      true,
		"coinhive.com":            true,
		"cryptoloot.pro":          true,
		"nanopool.org":            true,
		"2miners.com":             true,
		"herominers.com":          true,
		"hashvault.pro":           true,
		"supportxmr.com":          true,
		"unmineable.com":          true,
		"nicehash.com":            true,
		"ethermine.org":           true,
		"flexpool.io":             true,
		"f2pool.com":              true,
		"poolin.com":              true,
		"antpool.com":             true,
		"minexmr.com":             true,

		// === Cloud Deployment APIs (DNS Blackhole) ===
		"api.vercel.com":          true,
		"vercel.com":              true,
		"api.fly.io":              true,
		"fly.io":                  true,
		"api.heroku.com":          true,
		"heroku.com":              true,
		"git.heroku.com":          true,
		"api.railway.app":         true,
		"railway.app":             true,
		"api.render.com":          true,
		"render.com":              true,
		"api.netlify.com":         true,
		"netlify.com":             true,
		"app.netlify.com":         true,
		"api.cloudflare.com":      true,
		"api.deno.com":            true,
		"dash.deno.com":           true,
		"api.digitalocean.com":    true,
		"api.linode.com":          true,
		"api.vultr.com":           true,
		"api.hetzner.cloud":       true,
		"amazonaws.com":           true,
		"awsapps.com":             true,
		"googleapis.com":          true,
		"cloud.google.com":        true,
		"management.azure.com":    true,
		"azure.com":               true,
		"azurewebsites.net":       true,
		"azurecr.io":              true,
		"hub.docker.com":          true,
		"registry.hub.docker.com": true,
		"ghcr.io":                 true,
		"workers.dev":             true,
		"pages.dev":               true,
		"supabase.co":             true,
		"supabase.com":            true,
		"neon.tech":               true,
		"planetscale.com":         true,

		// === Tunnel Services ===
		"ngrok.com":               true,
		"ngrok.io":                true,
		"ngrok-agent.com":         true,
		"connect.ngrok-agent.com": true,
		"tunnel.ngrok.com":        true,
		"equinox.io":              true,
		"cloudflared.com":         true,
		"argotunnel.com":          true,
		"trycloudflare.com":       true,
		"localtunnel.me":          true,
		"loca.lt":                 true,
		"localhost.run":           true,
		"serveo.net":              true,
		"bore.pub":                true,
		"telebit.cloud":           true,
		"tailscale.com":           true,
		"login.tailscale.com":     true,
		"controlplane.tailscale.com": true,
		"zerotier.com":            true,
		"my.zerotier.com":         true,
		"pagekite.net":            true,
		"burrow.io":               true,
		"expose.dev":              true,
		"zrok.io":                 true,
		"pinggy.io":               true,
		"packetriot.com":          true,

		// === C2 / Paste infrastructure ===
		"pastebin.com":            true,
	}
}

// tunnelOnlyBlacklist returns the blacklist for tunnel_guard mode (paid dev tiers).
// Only blocks tunnel services and crypto mining. Cloud APIs are allowed.
func tunnelOnlyBlacklist() map[string]bool {
	return map[string]bool{
		// === Crypto mining pools ===
		"pool.minergate.com":      true,
		"xmr.pool.minergate.com":  true,
		"moneroocean.stream":      true,
		"coinhive.com":            true,
		"cryptoloot.pro":          true,
		"nanopool.org":            true,
		"2miners.com":             true,
		"herominers.com":          true,
		"hashvault.pro":           true,
		"supportxmr.com":          true,
		"unmineable.com":          true,
		"nicehash.com":            true,
		"ethermine.org":           true,
		"flexpool.io":             true,
		"f2pool.com":              true,
		"poolin.com":              true,
		"antpool.com":             true,
		"minexmr.com":             true,

		// === Tunnel Services ===
		"ngrok.com":               true,
		"ngrok.io":                true,
		"ngrok-agent.com":         true,
		"connect.ngrok-agent.com": true,
		"tunnel.ngrok.com":        true,
		"equinox.io":              true,
		"cloudflared.com":         true,
		"argotunnel.com":          true,
		"trycloudflare.com":       true,
		"localtunnel.me":          true,
		"loca.lt":                 true,
		"localhost.run":           true,
		"serveo.net":              true,
		"bore.pub":                true,
		"telebit.cloud":           true,
		"tailscale.com":           true,
		"login.tailscale.com":     true,
		"controlplane.tailscale.com": true,
		"zerotier.com":            true,
		"my.zerotier.com":         true,
		"pagekite.net":            true,
		"burrow.io":               true,
		"expose.dev":              true,
		"zrok.io":                 true,
		"pinggy.io":               true,
		"packetriot.com":          true,
	}
}

// Start begins listening for DNS queries.
func (r *Resolver) Start() error {
	addr := fmt.Sprintf(":%d", r.port)
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	defer conn.Close()

	log.Printf("[warden-dns] Listening on %s (upstream: %s)", addr, r.upstream)
	r.running = true

	buf := make([]byte, 512)
	for {
		n, clientAddr, err := conn.ReadFrom(buf)
		if err != nil {
			log.Printf("[warden-dns] Read error: %v", err)
			continue
		}

		go r.handleQuery(conn, clientAddr, buf[:n])
	}
}

// IsRunning returns whether the resolver is active.
func (r *Resolver) IsRunning() bool {
	return r.running
}

// DNS query types that are commonly used for tunneling
// and serve no legitimate purpose for a dev workspace.
var blockedQTypes = map[uint16]string{
	10:  "NULL",  // Used by dnscat2 and iodine
	16:  "TXT",   // Used by dnscat2, dns2tcp
	255: "ANY",   // Amplification + can return TXT records
	// MX and SRV can also carry tunnel data
	15:  "MX",
	33:  "SRV",
	// HINFO, NAPTR — exotic types used for tunneling
	13:  "HINFO",
	35:  "NAPTR",
}

func (r *Resolver) handleQuery(conn net.PacketConn, clientAddr net.Addr, query []byte) {
	// Minimal DNS parsing: extract query name from the question section
	if len(query) < 12 {
		return
	}

	// Rate limit: prevent DNS tunneling via high query volume
	srcIP := clientAddr.String()
	if host, _, err := net.SplitHostPort(srcIP); err == nil {
		srcIP = host
	}
	if !r.limiter.allow(srcIP) {
		log.Printf("[warden-dns] RATE LIMITED: %s", srcIP)
		r.sendNXDomain(conn, clientAddr, query)
		return
	}

	domain, qtype := extractQueryInfo(query)
	if domain == "" {
		// Can't parse — forward anyway
		r.forward(conn, clientAddr, query)
		return
	}

	// Block tunneling-prone query types (TXT, NULL, ANY, MX, SRV, etc.)
	if typeName, blocked := blockedQTypes[qtype]; blocked {
		log.Printf("[warden-dns] BLOCKED qtype=%s(%d) for %s", typeName, qtype, domain)
		r.sendNXDomain(conn, clientAddr, query)
		return
	}

	// Check blacklist
	if r.isBlacklisted(domain) {
		log.Printf("[warden-dns] BLOCKED: %s", domain)
		r.sendNXDomain(conn, clientAddr, query)
		return
	}

	// Check for DNS tunneling (high entropy subdomain labels)
	if r.isSuspiciousTunneling(domain) {
		log.Printf("[warden-dns] BLOCKED (tunneling suspected): %s", domain)
		r.sendNXDomain(conn, clientAddr, query)
		return
	}

	// Forward to upstream (only A, AAAA, CNAME queries reach here)
	r.forward(conn, clientAddr, query)
}

func (r *Resolver) isBlacklisted(domain string) bool {
	domain = strings.TrimSuffix(domain, ".")
	domain = strings.ToLower(domain)

	if r.blacklist[domain] {
		return true
	}

	// Check parent domains (e.g., sub.coinhive.com → coinhive.com)
	parts := strings.Split(domain, ".")
	for i := 1; i < len(parts)-1; i++ {
		parent := strings.Join(parts[i:], ".")
		if r.blacklist[parent] {
			return true
		}
	}

	return false
}

// isSuspiciousTunneling detects DNS tunneling via entropy analysis.
// Encoded data in subdomain labels has high entropy (>3.5 bits/char).
func (r *Resolver) isSuspiciousTunneling(domain string) bool {
	parts := strings.Split(strings.TrimSuffix(domain, "."), ".")
	if len(parts) < 3 {
		return false
	}

	// Check the leftmost label (most likely to contain encoded data)
	label := parts[0]
	if len(label) > 40 && shannonEntropy(label) > 3.5 {
		return true
	}

	return false
}

func shannonEntropy(s string) float64 {
	if len(s) == 0 {
		return 0
	}

	freq := make(map[rune]float64)
	for _, c := range s {
		freq[c]++
	}

	length := float64(len(s))
	entropy := 0.0
	for _, count := range freq {
		p := count / length
		if p > 0 {
			entropy -= p * math.Log2(p)
		}
	}

	return entropy
}

func (r *Resolver) forward(conn net.PacketConn, clientAddr net.Addr, query []byte) {
	upstreamAddr, err := net.ResolveUDPAddr("udp", r.upstream)
	if err != nil {
		log.Printf("[warden-dns] Failed to resolve upstream: %v", err)
		return
	}

	upstreamConn, err := net.DialUDP("udp", nil, upstreamAddr)
	if err != nil {
		log.Printf("[warden-dns] Failed to connect to upstream: %v", err)
		return
	}
	defer upstreamConn.Close()

	_, err = upstreamConn.Write(query)
	if err != nil {
		log.Printf("[warden-dns] Failed to send to upstream: %v", err)
		return
	}

	buf := make([]byte, 512)
	n, err := upstreamConn.Read(buf)
	if err != nil {
		log.Printf("[warden-dns] Failed to read from upstream: %v", err)
		return
	}

	conn.WriteTo(buf[:n], clientAddr)
}

func (r *Resolver) sendNXDomain(conn net.PacketConn, clientAddr net.Addr, query []byte) {
	if len(query) < 12 {
		return
	}

	// Build NXDOMAIN response: copy query header, set response flags
	response := make([]byte, len(query))
	copy(response, query)

	// Set QR=1 (response), RCODE=3 (NXDOMAIN)
	response[2] = 0x81 // QR=1, Opcode=0, AA=0, TC=0, RD=1
	response[3] = 0x83 // RA=1, Z=0, RCODE=3 (NXDOMAIN)

	// Zero answer, authority, additional counts
	response[6] = 0
	response[7] = 0
	response[8] = 0
	response[9] = 0
	response[10] = 0
	response[11] = 0

	conn.WriteTo(response, clientAddr)
}

// extractQueryInfo parses a DNS query to get the domain name and QTYPE.
// Returns empty domain if parsing fails.
func extractQueryInfo(query []byte) (domain string, qtype uint16) {
	if len(query) < 13 {
		return "", 0
	}

	// Skip header (12 bytes), parse QNAME labels
	offset := 12
	var labels []string

	for offset < len(query) {
		labelLen := int(query[offset])
		if labelLen == 0 {
			offset++ // skip the null terminator
			break
		}
		offset++
		if offset+labelLen > len(query) {
			return "", 0
		}
		labels = append(labels, string(query[offset:offset+labelLen]))
		offset += labelLen
	}

	domain = strings.Join(labels, ".")

	// QTYPE is the 2 bytes immediately after QNAME's null terminator
	if offset+2 <= len(query) {
		qtype = uint16(query[offset])<<8 | uint16(query[offset+1])
	}

	return domain, qtype
}
