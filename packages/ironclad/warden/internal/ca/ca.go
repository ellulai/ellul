// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Certificate Authority for MITM HTTPS inspection
//
// Loads the Coemad Root CA and generates on-the-fly leaf certificates
// for each intercepted domain. Certs are cached per-domain with 24h TTL.

package ca

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"sync"
	"time"
)

// CA holds the root certificate authority for MITM.
type CA struct {
	cert    *x509.Certificate
	key     *rsa.PrivateKey
	cache   map[string]*cachedCert
	cacheMu sync.RWMutex
	ttl     time.Duration
}

type cachedCert struct {
	tlsCert   tls.Certificate
	expiresAt time.Time
}

// Load initializes the CA from PEM files.
func Load(certFile, keyFile string) (*CA, error) {
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return nil, fmt.Errorf("read cert: %w", err)
	}

	keyPEM, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("read key: %w", err)
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, fmt.Errorf("failed to decode cert PEM")
	}

	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse cert: %w", err)
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, fmt.Errorf("failed to decode key PEM")
	}

	key, err := x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse key: %w", err)
	}

	return &CA{
		cert:  cert,
		key:   key,
		cache: make(map[string]*cachedCert),
		ttl:   24 * time.Hour,
	}, nil
}

// GenerateLeaf creates a TLS certificate for the given domain,
// signed by the root CA. Results are cached.
func (ca *CA) GenerateLeaf(domain string) (*tls.Certificate, error) {
	// Check cache
	ca.cacheMu.RLock()
	if cached, ok := ca.cache[domain]; ok && time.Now().Before(cached.expiresAt) {
		ca.cacheMu.RUnlock()
		return &cached.tlsCert, nil
	}
	ca.cacheMu.RUnlock()

	// Generate new leaf cert
	leafKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}

	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("generate serial: %w", err)
	}

	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName:   domain,
			Organization: []string{"ellul.ai Warden"},
		},
		DNSNames:  []string{domain},
		NotBefore: time.Now().Add(-1 * time.Hour),
		NotAfter:  time.Now().Add(ca.ttl),
		KeyUsage:  x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, ca.cert, &leafKey.PublicKey, ca.key)
	if err != nil {
		return nil, fmt.Errorf("create cert: %w", err)
	}

	tlsCert := tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  leafKey,
	}

	// Cache it
	ca.cacheMu.Lock()
	ca.cache[domain] = &cachedCert{
		tlsCert:   tlsCert,
		expiresAt: time.Now().Add(ca.ttl),
	}
	ca.cacheMu.Unlock()

	return &tlsCert, nil
}

// CleanExpired removes expired entries from the cert cache.
func (ca *CA) CleanExpired() {
	ca.cacheMu.Lock()
	defer ca.cacheMu.Unlock()

	now := time.Now()
	for domain, cached := range ca.cache {
		if now.After(cached.expiresAt) {
			delete(ca.cache, domain)
		}
	}
}
