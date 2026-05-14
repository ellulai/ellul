// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Warden — Network enforcement proxy for ellul.ai
//
// Two modes:
//
// hotel_california (free tier): All outbound traffic from `coder` user is
// redirected through Warden via iptables REDIRECT. Uses goproxy MITM to
// inspect HTTP methods inside TLS and enforce "code comes in, can't leave."
//
// tunnel_guard (paid dev tiers): All outbound traffic from `dev` user is
// redirected through Warden via iptables REDIRECT. Uses transparent TCP
// proxying with SNI/Host extraction to block tunnel services and crypto
// mining. No MITM — connections are forwarded raw after domain check.
//
// Warden also runs a forwarding DNS resolver on :5353 to block
// known-bad domains (tunnels, mining, and optionally cloud APIs).

package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/ellul.ai/warden/internal/dns"
	"github.com/ellul.ai/warden/internal/health"
	"github.com/ellul.ai/warden/internal/proxy"
)

func main() {
	proxyPort := flag.Int("proxy-port", 8080, "HTTP/HTTPS proxy port")
	dnsPort := flag.Int("dns-port", 5353, "DNS resolver port")
	healthPort := flag.Int("health-port", 8081, "Health check port")
	rulesFile := flag.String("rules", "/etc/warden/rules.yaml", "Hotel California rules file")
	caKeyFile := flag.String("ca-key", "/etc/warden/ca.key", "Root CA private key")
	caCertFile := flag.String("ca-cert", "/etc/warden/ca.crt", "Root CA certificate")
	bandwidthKBs := flag.Int("bandwidth", 500, "Max outbound bandwidth in KB/s (0 = unlimited)")
	mode := flag.String("mode", "hotel_california", "Enforcement mode: hotel_california or tunnel_guard")
	flag.Parse()

	log.Printf("[warden] Starting in %s mode", *mode)
	log.Printf("[warden] Proxy: :%d, DNS: :%d, Health: :%d", *proxyPort, *dnsPort, *healthPort)

	// Load rules (file may set mode, but CLI flag overrides)
	rules, err := proxy.LoadRules(*rulesFile)
	if err != nil {
		log.Printf("[warden] Warning: could not load rules file, using defaults: %v", err)
		rules = proxy.DefaultRules()
	}
	rules.Mode = *mode

	// Start DNS resolver (blocking known-bad domains)
	dnsResolver := dns.NewResolverWithMode(*dnsPort, *mode)
	go func() {
		if err := dnsResolver.Start(); err != nil {
			log.Fatalf("[warden] DNS resolver failed: %v", err)
		}
	}()

	// Start proxy — mode determines which proxy implementation to use:
	// - tunnel_guard: transparent TCP proxy (SO_ORIGINAL_DST + SNI extraction)
	// - hotel_california: goproxy MITM proxy (HTTP CONNECT + TLS interception)
	var proxyRunner health.ProxyRunner

	if *mode == "tunnel_guard" {
		// Transparent proxy: no MITM, just domain-level blocking via SNI/Host.
		// Works with iptables REDIRECT because it handles raw TCP connections
		// directly instead of expecting HTTP CONNECT.
		tp, err := proxy.NewTransparent(proxy.Config{
			Port:  *proxyPort,
			Rules: rules,
		})
		if err != nil {
			log.Fatalf("[warden] Failed to create transparent proxy: %v", err)
		}
		proxyRunner = tp
		go func() {
			if err := tp.Start(); err != nil {
				log.Fatalf("[warden] Transparent proxy failed: %v", err)
			}
		}()
	} else {
		// MITM proxy: full HTTP method inspection inside TLS.
		// hotel_california mode needs this to enforce GET-only policy.
		p, err := proxy.New(proxy.Config{
			Port:        *proxyPort,
			CAKeyFile:   *caKeyFile,
			CACertFile:  *caCertFile,
			Rules:       rules,
			BandwidthKB: *bandwidthKBs,
		})
		if err != nil {
			log.Fatalf("[warden] Failed to create MITM proxy: %v", err)
		}
		proxyRunner = p
		go func() {
			if err := p.Start(); err != nil {
				log.Fatalf("[warden] MITM proxy failed: %v", err)
			}
		}()
	}

	// Start health check endpoint
	h := health.New(*healthPort, proxyRunner, dnsResolver)
	go func() {
		if err := h.Start(); err != nil {
			log.Fatalf("[warden] Health check failed: %v", err)
		}
	}()

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("[warden] Shutting down")
}
