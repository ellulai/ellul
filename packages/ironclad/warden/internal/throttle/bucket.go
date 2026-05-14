// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Token bucket rate limiter for bandwidth throttling.
//
// Used by the Warden proxy to limit outbound bandwidth
// for free tier users (default: 500KB/s).

package throttle

import (
	"sync"
	"time"
)

// Bucket implements a token bucket rate limiter.
type Bucket struct {
	mu       sync.Mutex
	tokens   float64
	capacity float64 // max tokens (burst size)
	rate     float64 // tokens per second
	lastFill time.Time
}

// NewBucket creates a token bucket with the given rate (bytes/sec) and burst capacity.
func NewBucket(bytesPerSecond int, burstBytes int) *Bucket {
	return &Bucket{
		tokens:   float64(burstBytes),
		capacity: float64(burstBytes),
		rate:     float64(bytesPerSecond),
		lastFill: time.Now(),
	}
}

// Take removes n tokens from the bucket. Returns the time to wait
// before the tokens are available. If tokens are available, returns 0.
func (b *Bucket) Take(n int) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.lastFill).Seconds()
	b.lastFill = now

	// Refill tokens based on elapsed time
	b.tokens += elapsed * b.rate
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}

	if float64(n) <= b.tokens {
		b.tokens -= float64(n)
		return 0
	}

	// Not enough tokens — calculate wait time
	deficit := float64(n) - b.tokens
	b.tokens = 0
	waitSeconds := deficit / b.rate

	return time.Duration(waitSeconds * float64(time.Second))
}
