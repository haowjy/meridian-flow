# Go streaming middleware research

Date: 2026-03-20

## Executive Summary

The Go ecosystem does not converge on one universal streaming middleware abstraction. The strongest recurring patterns are:

- Explicit context-aware helpers for channel send/receive and simple transforms.
- Wrapper objects with lifecycle methods when the stream needs `Close`, `Err`, or `Next`/`Receive`.
- Interceptors that wrap a stream connection object, not a raw channel.
- Iterator-style APIs for pull-based consumption when backpressure is naturally single-consumer.

For a Go LLM provider library, the best fit is usually a two-layer design:

- Keep a stream wrapper type as the public primitive.
- Put boilerplate reduction into small helper functions like `ProxyStream` and `SendContext`, not a large Rx-style framework.

## 1) Proxy helpers and channel transforms

### `github.com/nalgeon/chans`

URL: https://pkg.go.dev/github.com/nalgeon/chans

Relevant APIs:

- `func Map[V, U any](ctx context.Context, out chan<- U, in <-chan V, fn func(V) (U, error)) error`
- `func Filter[V any](ctx context.Context, out chan<- V, in <-chan V, keep func(V) (bool, error)) error`
- `func Reduce[V, U any](ctx context.Context, in <-chan V, init U, fn func(U, V) U) U`
- `func Merge[V any](ctx context.Context, out chan<- V, ins ...<-chan V)`
- `func Split[V any](ctx context.Context, outs []chan<- V, in <-chan V)`

What it shows:

- Synchronous transforms are idiomatic when the caller already owns the channels.
- The package is intentionally unopinionated: callers own channel closure, and most functions run in the caller goroutine.
- `Merge` is the main operation that uses extra goroutines.

Tradeoffs and gotchas:

- Good for a `ProxyStream`-style helper that just forwards/transforms events.
- Easy to reason about because ownership stays with the caller.
- Less ergonomic if you want a fully wrapped stream object with lifecycle methods.
- `Merge` still blocks on the output channel; a slow consumer stalls all inputs.

### `github.com/baxromumarov/scoped/chanx`

URL: https://pkg.go.dev/github.com/baxromumarov/scoped/chanx

Relevant APIs:

- `func Map[T, U any](ctx context.Context, in <-chan T, fn func(T) U) <-chan U`
- `func Filter[T any](ctx context.Context, in <-chan T, fn func(T) bool) <-chan T`
- `func OrDone[T any](ctx context.Context, in <-chan T) <-chan T`
- `func Send[T any](ctx context.Context, ch chan<- T, v T) error`
- `func Recv[T any](ctx context.Context, ch <-chan T) (T, bool, error)`
- `func Merge[T any](ctx context.Context, chs ...<-chan T) <-chan T`
- `func FanOut[T any](ctx context.Context, in <-chan T, n int) []<-chan T`
- `func Tee[T any](ctx context.Context, in <-chan T, n int) []<-chan T`

What it shows:

- This is very close to the helper set you would want for channel-based stream middleware.
- It encodes the context-aware send/receive pattern directly, which is the main leak prevention mechanism.
- It also exposes higher-level fan-in/fan-out and batching operations.

Tradeoffs and gotchas:

- Ergonomic for pipelines, but it starts to look like a small streaming framework.
- Some operations require all outputs to be consumed concurrently; that is a common deadlock trap.
- `FanOut`, `Tee`, and `Partition` style APIs force you to think about worker ownership and head-of-line blocking.

### `github.com/fxsml/gopipe`

URL: https://pkg.go.dev/github.com/fxsml/gopipe

Relevant API:

- `type Pipe[In, Out any] func(ctx context.Context, in <-chan In) <-chan Out`

What it shows:

- A pipeline abstraction can be modeled as a first-class function.
- This is a good fit if you want composition at the pipeline boundary instead of only per-event middleware.

Tradeoffs and gotchas:

- More framework-like than `chans` or `chanx`.
- Useful if you want to compose stages, batching, retry, or observability.
- Probably too much abstraction if the main goal is just to eliminate repetitive goroutine plumbing in middleware.

### `github.com/hopeio/utils/iter`

URL: https://pkg.go.dev/github.com/hopeio/utils/iter

Relevant APIs:

- `func Filter[T any](seq iter.Seq[T], test types.Predicate[T]) iter.Seq[T]`
- `func FlatMap[T any](...) Stream[T]`
- `func Collect[T any, S any, R any](it iter.Seq[T], collector interfaces.Collector[S, T, R]) R`

What it shows:

- Generic stream types can sit on top of the standard `iter.Seq` pull model.
- This is closer to `Stream[T]` than to bare channels.

Tradeoffs and gotchas:

- Better for pull-based iteration than for async event delivery.
- Less directly compatible with middleware that needs to fan out or push events from a producer goroutine.

## 2) Context-aware sends and disconnect handling

### `net/http`

URL: https://pkg.go.dev/net/http

Relevant API:

- `func (r *Request) Context() context.Context`

What it shows:

- For incoming server requests, request context is canceled when the client connection closes, the request is canceled, or the handler returns.
- This is the standard hook for stopping a stream when the consumer disconnects.

Practical implication:

- Any middleware that forwards to a downstream channel should select on `ctx.Done()` before blocking on send.
- If the producer goroutine does not observe context cancellation, the helper cannot prevent leaks by itself.

### `github.com/coder/websocket`

URL: https://pkg.go.dev/github.com/coder/websocket

Relevant APIs:

- `func (c *Conn) Read(ctx context.Context) (MessageType, []byte, error)`
- `func (c *Conn) CloseRead(ctx context.Context) context.Context`
- `func (c *Conn) Close(code StatusCode, reason string) error`

What it shows:

- WebSocket libraries in Go lean hard on `context.Context` for cancellation.
- `CloseRead` is a common pattern for write-only or write-mostly connections: keep one goroutine reading so close/ping/pong frames are handled and the returned context is canceled on disconnect.

Tradeoffs and gotchas:

- You must keep reading somewhere, or control frames may not be processed.
- Context cancellation closes the connection, so cleanup paths need to tolerate partial writes and EOF-like termination.

### `github.com/r3labs/sse/v2`

URL: https://pkg.go.dev/github.com/r3labs/sse/v2

Relevant APIs:

- `func (c *Client) SubscribeWithContext(ctx context.Context, stream string, handler func(msg *Event)) error`
- `func (c *Client) SubscribeChanWithContext(ctx context.Context, stream string, ch chan *Event) error`
- `func (c *Client) SubscribeRawWithContext(ctx context.Context, handler func(msg *Event)) error`
- `func (c *Client) SubscribeChanRawWithContext(ctx context.Context, ch chan *Event) error`

What it shows:

- SSE clients in Go frequently expose both callback and channel forms, plus context-aware variants.
- The context-aware forms are the important part for stream middleware design.

Tradeoffs and gotchas:

- Channel forms are convenient, but they still leave ownership and draining rules on the caller.
- Context-aware variants are mandatory if you want clean shutdown on disconnect.

### `github.com/sashabaranov/go-openai`

URL: https://pkg.go.dev/github.com/sashabaranov/go-openai

Relevant APIs:

- `func (c *Client) CreateChatCompletionStream(ctx context.Context, request ChatCompletionRequest) (stream *ChatCompletionStream, err error)`
- `func (c *Client) CreateCompletionStream(ctx context.Context, request CompletionRequest) (stream *CompletionStream, err error)`
- `func (stream ChatCompletionStream) Recv() (response T, err error)`
- `func (stream ChatCompletionStream) Close() error`
- `func (stream CompletionStream) Recv() (response T, err error)`
- `func (stream CompletionStream) Close() error`

What it shows:

- The stream is not a channel; it is a cursor object with explicit `Recv` and `Close`.
- This is a strong precedent for wrapping streaming responses in a lifecycle-aware type.

Tradeoffs and gotchas:

- More verbose than a bare channel.
- Much easier to manage cleanup and early termination than a raw `<-chan`.

### `github.com/anthropics/anthropic-sdk-go/packages/ssestream`

URL: https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go/packages/ssestream

Relevant APIs:

- `func NewStream[T any](decoder Decoder, err error) *Stream[T]`
- `func (s *Stream[T]) Next() bool`
- `func (s *Stream[T]) Current() T`
- `func (s *Stream[T]) Err() error`
- `func (s *Stream[T]) Close() error`

What it shows:

- This is the clearest Go precedent for a typed streaming wrapper around a low-level decoder.
- It separates iteration, current item access, error access, and cleanup.

Tradeoffs and gotchas:

- Great fit for a public stream type in an LLM SDK.
- The API is pull-oriented, not a direct channel proxy, so a separate adapter may still be useful if middleware wants push semantics.

### `github.com/tmc/langchaingo/llms`

URL: https://pkg.go.dev/github.com/tmc/langchaingo/llms

Relevant APIs:

- `func WithStreamingFunc(streamingFunc func(ctx context.Context, chunk []byte) error) CallOption`
- `func WithStreamingReasoningFunc(streamingReasoningFunc func(ctx context.Context, reasoningChunk, chunk []byte) error) CallOption`

What it shows:

- Langchaingo uses callbacks rather than channels for streaming.
- The callback can return an error to stop the stream early, which is useful for cancellation or custom stop conditions.

Tradeoffs and gotchas:

- This is a good fit for simple event taps and logging.
- It is less expressive than a typed stream object if you need lifecycle methods, buffering, or event replay.

## 3) Wrapper types and standard library precedents

### `bufio.Scanner`

URL: https://pkg.go.dev/bufio

Relevant APIs:

- `func (s *Scanner) Scan() bool`
- `func (s *Scanner) Text() string`
- `func (s *Scanner) Err() error`
- `func (s *Scanner) Split(split SplitFunc)`

Why it matters:

- This is the classic Go precedent for a cursor-like stream wrapper.
- `Scan` advances, `Text` reads the current token, and `Err` reports terminal failure.

Gotchas:

- It is single-use and stateful.
- The split function must be configured before scanning begins.

### `database/sql.Rows`

URL: https://pkg.go.dev/database/sql

Relevant APIs:

- `func (rs *Rows) Close() error`
- `func (rs *Rows) Err() error`
- `func (rs *Rows) Next() bool`
- `func (rs *Rows) Scan(dest ...any) error`

Why it matters:

- `Rows` is another cursor object with explicit cleanup and error inspection.
- The shape is similar to what a typed streaming wrapper would look like for LLM events.

Gotchas:

- State is hidden behind methods, so concurrent access rules need to be documented carefully.
- Closing behavior and automatic exhaustion matter; this is not a dumb container.

### `iter.Seq`

URL: https://pkg.go.dev/iter

Relevant APIs:

- `type Seq[V any] func(yield func(V) bool)`
- `func Pull[V any](seq Seq[V]) (next func() (V, bool), stop func())`

Why it matters:

- The standard library now has an official pull/push iterator abstraction.
- `Pull` explicitly requires `stop` when the consumer stops early, which is the same resource-management problem streaming middleware faces.

Gotchas:

- It is not a channel and does not model asynchronous delivery by itself.
- The docs warn that `next` and `stop` must not be called from multiple goroutines simultaneously.

## 4) Stream middleware composition

### `google.golang.org/grpc`

URL: https://pkg.go.dev/google.golang.org/grpc

Relevant APIs:

- `func ChainStreamInterceptor(interceptors ...StreamServerInterceptor) ServerOption`
- `type StreamServerInterceptor func(srv any, ss ServerStream, info *StreamServerInfo, handler StreamHandler) error`
- `func StreamInterceptor(i StreamServerInterceptor) ServerOption`

What it shows:

- gRPC composes stream middleware as wrappers around the stream and its handler.
- The first interceptor is the outermost wrapper.

Tradeoffs and gotchas:

- Composition order matters.
- Interceptors must always call the next handler or explicitly terminate the RPC.

### `connectrpc.com/connect`

URL: https://pkg.go.dev/connectrpc.com/connect

Relevant APIs:

- `type StreamingClientFunc func(context.Context, Spec) StreamingClientConn`
- `type StreamingHandlerFunc func(context.Context, StreamingHandlerConn) error`
- `type StreamingClientConn interface { Send(any) error; Receive(any) error; CloseResponse() error; ... }`
- `type StreamingHandlerConn interface { Send(any) error; Receive(any) error; ... }`
- `WithInterceptors(A, B, ...)` composes stream interceptors like an onion

What it shows:

- Connect wraps the stream connection object itself, which is very close to what you would want for LLM streaming middleware.
- The API clearly separates client and handler directions.

Tradeoffs and gotchas:

- Very expressive for stream middleware.
- The transport-level object is more complex than a bare channel, but that complexity buys you better lifecycle control.

## Recommendation

For a Go LLM provider library, I would not keep middleware built directly on bare `<-chan StreamEvent` as the public abstraction.

Recommended shape:

- Public type: `Stream[T]` with `Next`, `Current`, `Err`, `Close`, and `Context` or `Done`.
- Internal helper: `ProxyStream` for the common wrapper pattern, with context-aware send and a clear ownership rule.
- Small channel utility layer: `SendContext`, `RecvContext`, maybe `OrDone`.
- Optional higher-level operators only where you need them: `Map`, `Filter`, `Merge`, `FanOut`.

Why:

- This matches how Go libraries handle long-lived streaming objects in practice.
- It makes cancellation and cleanup explicit.
- It avoids goroutine leaks that are easy to create with ad hoc proxy goroutines.
- It keeps room for middleware composition without turning the package into a framework.

Main tradeoff:

- Bare channels are minimal.
- Wrapper streams are more verbose, but they encode the lifecycle rules that streaming LLM APIs usually need.

Practical failure modes to guard against:

- Writing to an output channel after the consumer has disconnected.
- Hidden goroutines that do not watch context cancellation.
- Fan-out helpers whose outputs are not drained concurrently.
- Ambiguous ownership of channel closing.

## Sources

- https://pkg.go.dev/github.com/nalgeon/chans
- https://pkg.go.dev/github.com/baxromumarov/scoped/chanx
- https://pkg.go.dev/github.com/fxsml/gopipe
- https://pkg.go.dev/github.com/hopeio/utils/iter
- https://pkg.go.dev/net/http
- https://pkg.go.dev/github.com/coder/websocket
- https://pkg.go.dev/github.com/r3labs/sse/v2
- https://pkg.go.dev/github.com/sashabaranov/go-openai
- https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go/packages/ssestream
- https://pkg.go.dev/github.com/tmc/langchaingo/llms
- https://pkg.go.dev/bufio
- https://pkg.go.dev/database/sql
- https://pkg.go.dev/iter
- https://pkg.go.dev/google.golang.org/grpc
- https://pkg.go.dev/connectrpc.com/connect
