# Go stream wrapper patterns for LLM providers (2026-03-20)

## Question
Should `StreamResponse(ctx, req) (<-chan StreamEvent, error)` become `StreamResponse(ctx, req) (*Stream, error)` for LLM provider libraries?

## Executive summary
The strongest production precedents favor a small `Stream` struct with lifecycle methods rather than returning a raw channel:

- `go-openai` uses `*ChatCompletionStream` / `*CompletionStream` with `Recv()` and `Close()`.
- `anthropic-sdk-go` uses a generic `ssestream.Stream[T]` with `Next()`, `Current()`, `Err()`, and `Close()`.
- `ollama/api` uses callback-style streaming, not a raw channel.
- `langchaingo` pushes streaming through callbacks in `CallOption` rather than exposing a core stream object.

The best fit for provider libraries is usually:

```go
stream, err := client.StreamResponse(ctx, req)
if err != nil { ... }
defer stream.Close()

for stream.Next() {
    ev := stream.Current()
    ...
}
if err := stream.Err(); err != nil { ... }
```

or a variant with `Recv() (T, error)` if you want a more explicit read API.

## 1. Production library patterns

### `sashabaranov/go-openai`
OpenAI streaming is wrapped in a typed stream object, not a channel.

Observed API shape:

```go
stream, err := client.CreateChatCompletionStream(ctx, req)
if err != nil {
    return err
}
defer stream.Close()

for {
    resp, err := stream.Recv()
    if errors.Is(err, io.EOF) {
        break
    }
    if err != nil {
        return err
    }
    fmt.Println(resp.Choices[0].Delta.Content)
}
```

Takeaway:
- Strong precedent for `*Stream` with `Close()` and `Recv()`.
- Error and end-of-stream are out-of-band from the payload.
- Consumer ergonomics are good for one-reader, linear consumption.

Source: [`go-openai` pkg docs](https://pkg.go.dev/github.com/sashabaranov/go-openai#Client.CreateChatCompletionStream)

### `anthropic-sdk-go`
Anthropic’s Go SDK ships a generic stream wrapper in `packages/ssestream`.

Observed API shape:

```go
stream := ssestream.NewStream[Event](decoder, err)
defer stream.Close()

for stream.Next() {
    ev := stream.Current()
    ...
}
if err := stream.Err(); err != nil {
    return err
}
```

Stream type surface:

```go
type Stream[T any] struct{}
func NewStream[T any](decoder Decoder, err error) *Stream[T]
func (s *Stream[T]) Close() error
func (s *Stream[T]) Current() T
func (s *Stream[T]) Err() error
func (s *Stream[T]) Next() bool
```

Takeaway:
- This is the closest production precedent to a reusable generic `Stream[T]`.
- It separates iteration from payload transport cleanly.
- It supports a single consumer and explicit lifecycle control.

Source: [`ssestream` pkg docs](https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go/packages/ssestream)

### `langchaingo`
LangChain Go favors callbacks at the API edge instead of stream objects.

Observed API shape in `llms`:

```go
type CallOption interface{}
type StreamingFunc func(ctx context.Context, chunk []byte) error
```

Typical usage is to pass a streaming callback in options rather than return a channel or stream handle.

Also note:
- `llms.Model` exposes `GenerateContent(...)`, not `GenerateContentStream(...)`, in the core interface.
- Some test helpers still model streaming with channels, which suggests the ecosystem is mixed internally.

Takeaway:
- Callback streaming is viable when the primary goal is “emit tokens as they arrive.”
- It is weaker than a stream object when you need iteration, close semantics, or error inspection after the fact.

Source: [`langchaingo` llms docs](https://pkg.go.dev/github.com/tmc/langchaingo/llms)

### `ollama/ollama` Go client
The official Ollama API package uses callback-based streaming for chat.

Observed API shape:

```go
err := client.Chat(ctx, req, func(resp api.ChatResponse) error {
    fmt.Print(resp.Message.Content)
    return nil
})
```

The docs also describe progress callbacks for other endpoints:

```go
type CreateProgressFunc func(ProgressResponse) error
```

Takeaway:
- Ollama’s official Go surface prefers callback-based event delivery.
- This is ergonomic for simple sinks, but not as composable as a `Stream` object.

Source: [`ollama/api` pkg docs](https://pkg.go.dev/github.com/ollama/ollama/api)

## 2. Iterator and generic stream patterns

### Go 1.23 `iter.Seq` / range-over-func
Go’s iterator direction is pull-based, single-consumer, and composable with `for range` over a function-backed sequence.

Practical implication:
- Good for `Next`-style consumption and lazy pipelines.
- Less suited to push-driven transport unless you adapt your source into a sequence.
- Context cancellation still matters because a producer can block while the consumer is absent.

Concrete ecosystem signal:
- `samber/lo` now exposes an `it` subpackage for iterator helpers.
- iterator-oriented helper libraries are showing up alongside `iter.Seq`, which is the important direction signal here.

### Community shape of lightweight stream libraries
Takeaway:
- The community is converging on iterator abstractions for data processing, not raw channels.
- `ssestream.Stream[T]` from Anthropic is the clearest production example of a lightweight generic `Stream[T]`.
- For LLM provider SDKs, the transport-backed, single-consumer stream still maps better than a pure iterator.

### RxGo
Rx-style observables are powerful but usually too heavy for provider SDKs.

Why it is usually the wrong fit:
- Extra abstraction cost for a simple linear token stream.
- More concepts than most LLM client users need.
- Fan-out and composition are attractive, but most provider SDKs want “read once, cancel, close.”

Recommendation:
- Avoid Rx-style APIs unless the library’s core purpose is stream transformation, not LLM provider access.

## 3. API design answers

### Should `Stream` have `Close()`?
Yes.

Why:
- Mirrors `go-openai` and Anthropic’s `ssestream`.
- Provides an explicit escape hatch for early termination even if the context remains alive.
- Lets the stream own body/socket cleanup.

Preferred rule:

```go
stream, err := client.StreamResponse(ctx, req)
if err != nil {
    return err
}
defer stream.Close()
```

Relying only on `context.CancelFunc` is workable, but a `Close()` method is still useful as a resource-management primitive.

### Should `Stream` expose the channel directly?
Usually no.

Why:
- Exposing the channel leaks internal buffering and shutdown semantics.
- It complicates future API changes.
- You lose the ability to provide `Err()`, `Close()`, and stronger invariants.

If you need `range` ergonomics, prefer either:

```go
for stream.Next() {
    ev := stream.Current()
}
```

or a separate adapter:

```go
func (s *Stream[T]) Seq() iter.Seq[T]
```

### How should errors be surfaced?
Use out-of-band error state plus a terminal read signal.

Good patterns:
- `Recv() (T, error)` with `io.EOF`
- `Next() bool` + `Current()` + `Err()`

Avoid in-band error events for the primary error path unless the provider protocol itself sends structured stream errors.

Why:
- This keeps “payload” and “transport failure” distinct.
- It matches established Go SDK conventions.
- It makes consumer code deterministic at end of stream.

### Should `Stream` support fan-out?
Not by default.

Recommendation:
- Assume single-reader semantics.
- If fan-out is needed, provide an explicit `Tee`/`Broadcast` helper outside the core provider API.

Why:
- Fan-out is fundamentally a buffering and backpressure policy decision.
- A provider stream is usually a live network resource, not a replayable event log.
- Multiple readers create ambiguity around ordering, cancellation, and error delivery.

### What buffer size strategy is best?
Start small and bounded.

Recommended default:
- small fixed buffer for decoupling producer/consumer scheduling
- no unbounded queues

Practical guidance:
- Use a tiny buffer when token latency matters and consumer work is light.
- Increase only if decoding or event handling blocks the producer.
- Never let the queue be silently unbounded in a provider SDK.

Why:
- Streams from LLM providers are latency-sensitive.
- Larger buffers hide slow consumers but increase memory and cancellation lag.

## 4. Breaking-change migration patterns

### How Go libraries usually handle streaming API changes
Common patterns:

1. Add a new wrapper type and keep the old API as a thin adapter.
2. Introduce `Stream` alongside the old channel return type.
3. Mark the old method deprecated, then remove it in the next major version.

### Adapter shape for backwards compatibility

```go
func (c *Client) StreamResponse(ctx context.Context, req Request) (*Stream[Event], error) {
    ...
}

func (c *Client) StreamResponseChan(ctx context.Context, req Request) (<-chan Event, error) {
    stream, err := c.StreamResponse(ctx, req)
    if err != nil {
        return nil, err
    }
    ch := make(chan Event)
    go func() {
        defer close(ch)
        defer stream.Close()
        for stream.Next() {
            ch <- stream.Current()
        }
    }()
    return ch, nil
}
```

This keeps existing channel consumers alive while moving the core implementation to `Stream`.

### What to avoid
- Don’t make the new `Stream` a thin wrapper that only exposes `C <-chan T`; that keeps the same lifecycle limitations.
- Don’t require consumers to guess whether `Close()` is mandatory.
- Don’t hide transport errors only inside terminal events if you can expose them as `Err()`.

## Recommendation

Use `*Stream` as the primary API, not `<-chan T`.

Preferred shape:

```go
type Stream[T any] interface {
    Next() bool
    Current() T
    Err() error
    Close() error
}
```

If you want a simpler API for your domain, a concrete non-generic `*Stream` with `Recv()` is also a good fit:

```go
type Stream struct { ... }
func (s *Stream) Recv() (StreamEvent, error)
func (s *Stream) Close() error
```

Recommendation rationale:
- Matches the strongest production precedents.
- Preserves lifecycle control.
- Keeps the API extensible for future metadata, usage accounting, and termination reasons.
- Makes compatibility shims straightforward.

## Source index

- `go-openai`: https://pkg.go.dev/github.com/sashabaranov/go-openai#Client.CreateChatCompletionStream
- `anthropic-sdk-go ssestream`: https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go/packages/ssestream
- `langchaingo llms`: https://pkg.go.dev/github.com/tmc/langchaingo/llms
- `ollama/api`: https://pkg.go.dev/github.com/ollama/ollama/api
