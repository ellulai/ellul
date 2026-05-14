// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Health check endpoint for Warden
//
// Exposes /_health on a separate port for the enforcer daemon
// to verify Warden is running and functioning.

package health

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/ellul.ai/warden/internal/dns"
)

// ProxyRunner is implemented by both MITM and transparent proxies.
type ProxyRunner interface {
	IsRunning() bool
	Stats() (allowed, blocked int64)
}

// Health serves health check responses.
type Health struct {
	port     int
	proxy    ProxyRunner
	resolver *dns.Resolver
}

// New creates a health check server.
func New(port int, p ProxyRunner, r *dns.Resolver) *Health {
	return &Health{
		port:     port,
		proxy:    p,
		resolver: r,
	}
}

type healthResponse struct {
	Status       string `json:"status"`
	ProxyRunning bool   `json:"proxy_running"`
	DNSRunning   bool   `json:"dns_running"`
	Allowed      int64  `json:"requests_allowed"`
	Blocked      int64  `json:"requests_blocked"`
}

// Start begins the health check HTTP server.
func (h *Health) Start() error {
	mux := http.NewServeMux()

	mux.HandleFunc("/_health", func(w http.ResponseWriter, r *http.Request) {
		allowed, blocked := h.proxy.Stats()

		resp := healthResponse{
			Status:       "ok",
			ProxyRunning: h.proxy.IsRunning(),
			DNSRunning:   h.resolver.IsRunning(),
			Allowed:      allowed,
			Blocked:      blocked,
		}

		if !resp.ProxyRunning || !resp.DNSRunning {
			resp.Status = "degraded"
			w.WriteHeader(http.StatusServiceUnavailable)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	addr := fmt.Sprintf(":%d", h.port)
	log.Printf("[warden-health] Listening on %s", addr)
	return http.ListenAndServe(addr, mux)
}
