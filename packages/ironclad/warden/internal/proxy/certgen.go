// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Per-domain leaf certificate generation and caching for transparent MITM.
//
// Each intercepted domain gets a short-lived (24h) certificate signed by
// the Warden CA. Certs are cached to avoid key generation on every
// connection — one key per domain per day.
//
// Uses ECDSA P-256 for leaf keys: ~100x faster than RSA 2048 key gen,
// critical on CPU-limited free-tier VPSes where RSA caused 5-10s delays.
// The CA key is still RSA (loaded from disk, generated once at bake time).
//
// Security: cache is capped at maxCerts (10 000) to prevent memory
// exhaustion via SNI flooding. When full, oldest entries are evicted.

package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"net"
	"sync"
	"time"
)

const (
	certTTL  = 24 * time.Hour
	maxCerts = 10_000
)

type certStore struct {
	ca     tls.Certificate
	caX509 *x509.Certificate
	mu     sync.RWMutex
	cache  map[string]*leafEntry
}

type leafEntry struct {
	cert      *tls.Certificate
	createdAt time.Time
	expiresAt time.Time
}

func newCertStore(ca tls.Certificate, caX509 *x509.Certificate) *certStore {
	return &certStore{
		ca:     ca,
		caX509: caX509,
		cache:  make(map[string]*leafEntry),
	}
}

// get returns a cached leaf cert or generates a new one.
func (s *certStore) get(host string) (*tls.Certificate, error) {
	now := time.Now()

	s.mu.RLock()
	if e, ok := s.cache[host]; ok && now.Before(e.expiresAt) {
		s.mu.RUnlock()
		return e.cert, nil
	}
	s.mu.RUnlock()

	// Generate under write lock (double-check after acquiring)
	s.mu.Lock()
	defer s.mu.Unlock()

	if e, ok := s.cache[host]; ok && now.Before(e.expiresAt) {
		return e.cert, nil
	}

	leaf, err := s.generate(host)
	if err != nil {
		return nil, err
	}

	// Evict oldest if at capacity
	if len(s.cache) >= maxCerts {
		s.evictOldestLocked()
	}

	s.cache[host] = &leafEntry{cert: leaf, createdAt: now, expiresAt: now.Add(certTTL)}
	return leaf, nil
}

func (s *certStore) generate(host string) (*tls.Certificate, error) {
	// ECDSA P-256: ~0.1ms key gen vs ~50-100ms for RSA 2048.
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ecdsa keygen: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("serial: %w", err)
	}

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host, Organization: []string{"ellul.ai Warden"}},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(certTTL),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, s.caX509, &key.PublicKey, s.ca.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}

	cert := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	return cert, nil
}

// evictOldestLocked removes the oldest cache entry. Caller must hold s.mu.
func (s *certStore) evictOldestLocked() {
	var oldestKey string
	var oldestTime time.Time

	for k, e := range s.cache {
		if oldestKey == "" || e.createdAt.Before(oldestTime) {
			oldestKey = k
			oldestTime = e.createdAt
		}
	}

	if oldestKey != "" {
		delete(s.cache, oldestKey)
	}
}

// janitor removes expired entries every hour. Run as a goroutine.
func (s *certStore) janitor() {
	for {
		time.Sleep(time.Hour)

		s.mu.Lock()
		now := time.Now()
		for host, e := range s.cache {
			if now.After(e.expiresAt) {
				delete(s.cache, host)
			}
		}
		s.mu.Unlock()
	}
}
