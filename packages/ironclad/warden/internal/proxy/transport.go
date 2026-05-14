// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Bandwidth-throttled RoundTripper
//
// Limits outbound bandwidth for free tier users to prevent abuse.
// Default: 500KB/s (enough for npm install, not enough for torrenting).

package proxy

import (
	"io"
	"net/http"
	"time"
)

// ThrottledTransport wraps http.RoundTripper with bandwidth limiting.
type ThrottledTransport struct {
	base      http.RoundTripper
	rateBytes int64 // bytes per second
}

// NewThrottledTransport creates a bandwidth-limited transport.
func NewThrottledTransport(base http.RoundTripper, kbPerSecond int) *ThrottledTransport {
	return &ThrottledTransport{
		base:      base,
		rateBytes: int64(kbPerSecond) * 1024,
	}
}

// RoundTrip implements http.RoundTripper with bandwidth throttling.
func (t *ThrottledTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}

	// Wrap response body with throttled reader
	if resp.Body != nil {
		resp.Body = &throttledReader{
			reader:    resp.Body,
			rateBytes: t.rateBytes,
			lastRead:  time.Now(),
		}
	}

	return resp, nil
}

type throttledReader struct {
	reader    io.ReadCloser
	rateBytes int64
	lastRead  time.Time
	bytesRead int64
}

func (r *throttledReader) Read(p []byte) (n int, err error) {
	n, err = r.reader.Read(p)
	r.bytesRead += int64(n)

	// Simple token bucket: sleep if we're reading faster than the rate
	elapsed := time.Since(r.lastRead)
	expectedDuration := time.Duration(float64(r.bytesRead) / float64(r.rateBytes) * float64(time.Second))

	if expectedDuration > elapsed {
		time.Sleep(expectedDuration - elapsed)
	}

	return n, err
}

func (r *throttledReader) Close() error {
	return r.reader.Close()
}
