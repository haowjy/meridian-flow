package sse

import (
	"log/slog"
	"time"
)

// KeepAliveStrategy defines how keep-alive pings are sent to maintain SSE connections
// Allows different implementations (ticker-based, adaptive, custom) without modifying SSE handler
// Follows Open/Closed Principle - extend with new strategies without modifying existing code
type KeepAliveStrategy interface {
	// Start begins sending keep-alive pings using the provided writer
	// Returns a channel that signals when keep-alive should stop (e.g., connection dropped)
	// The strategy is responsible for stopping itself on write errors
	Start(writer KeepAliveWriter, logger *slog.Logger) <-chan struct{}

	// Stop terminates the keep-alive mechanism and cleans up resources
	Stop()
}

// KeepAliveWriter abstracts the mechanism for writing keep-alive messages
// Allows testing without real HTTP connections (Interface Segregation Principle)
type KeepAliveWriter interface {
	// WriteKeepAlive writes a keep-alive message (SSE comment)
	// Returns error if connection is closed or write fails
	WriteKeepAlive() error
}

// TickerKeepAlive implements periodic keep-alive using time.Ticker
// Sends keep-alive pings at fixed intervals until stopped or connection fails
type TickerKeepAlive struct {
	interval time.Duration
	ticker   *time.Ticker
	done     chan struct{}
}

// NewTickerKeepAlive creates a new ticker-based keep-alive strategy
// interval: How often to send keep-alive pings (e.g., 10 * time.Second)
func NewTickerKeepAlive(interval time.Duration) *TickerKeepAlive {
	return &TickerKeepAlive{
		interval: interval,
		done:     make(chan struct{}),
	}
}

// Start begins sending keep-alive pings on the specified interval
// Automatically stops if write fails (connection dropped)
// Returns a channel that closes when keep-alive terminates
func (k *TickerKeepAlive) Start(writer KeepAliveWriter, logger *slog.Logger) <-chan struct{} {
	k.ticker = time.NewTicker(k.interval)
	stopChan := make(chan struct{})

	go func() {
		defer close(stopChan)
		defer k.ticker.Stop()

		for {
			select {
			case <-k.ticker.C:
				// Attempt to write keep-alive
				if err := writer.WriteKeepAlive(); err != nil {
					// Connection dropped or write failed - stop keep-alive
					logger.Warn("keep-alive write failed, stopping",
						"error", err,
					)
					return
				}

			case <-k.done:
				// Explicit stop requested
				return
			}
		}
	}()

	return stopChan
}

// Stop terminates the keep-alive mechanism
// Safe to call multiple times
func (k *TickerKeepAlive) Stop() {
	select {
	case <-k.done:
		// Already closed
	default:
		close(k.done)
	}
}
