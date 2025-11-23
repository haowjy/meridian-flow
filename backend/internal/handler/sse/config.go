package sse

import "time"

// Config holds configuration for SSE connections
// Separates configuration concerns from handler logic (SRP)
type Config struct {
	// KeepAliveInterval is how often to send keep-alive pings to prevent timeouts
	// Recommended: 10-15 seconds for Vercel Edge Runtime
	KeepAliveInterval time.Duration
}

// DefaultConfig returns the default SSE configuration
// 10 seconds is safe for Vercel Edge Runtime and most proxies
func DefaultConfig() *Config {
	return &Config{
		KeepAliveInterval: 10 * time.Second,
	}
}
