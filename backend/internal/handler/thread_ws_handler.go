package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	authdomain "meridian/internal/domain/auth"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/streaming"
	"meridian/internal/wsutil"
)

const wsHandlerOpTimeout = 5 * time.Second

var _ wsutil.Handler = (*TurnStreamHandler)(nil)

type TurnStreamStarter interface{}

type TurnStreamHandlerDeps struct {
	StreamRegistry     *mstream.Registry
	InterjectionRouter streaming.InterjectionRouter
	ActiveTurnRegistry streaming.ActiveTurnRegistry
	TurnStreamStarter  TurnStreamStarter
	TurnReader         domainllm.TurnReader
	Authorizer         authdomain.ResourceAuthorizer
	Logger             *slog.Logger
}

// TurnStreamHandler handles turn stream subscribe/unsubscribe/message lifecycle.
type TurnStreamHandler struct {
	streamRegistry     *mstream.Registry
	interjectionRouter streaming.InterjectionRouter
	activeTurnRegistry streaming.ActiveTurnRegistry
	turnStreamStarter  TurnStreamStarter
	turnReader         domainllm.TurnReader
	authorizer         authdomain.ResourceAuthorizer
	logger             *slog.Logger
}

// Per-connection state.
type turnStreamState struct {
	session   wsutil.Session
	liveFeeds map[string]*liveFeed // subId -> mstream live feed
	turnSubs  map[string]string    // turnId -> subId
	mu        sync.Mutex
}

type liveFeed struct {
	turnID   string
	stream   *mstream.Stream
	liveChan <-chan mstream.Event
	ctx      context.Context
	cancel   context.CancelFunc
	headSeq  int64
}

func NewTurnStreamHandler(deps TurnStreamHandlerDeps) *TurnStreamHandler {
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &TurnStreamHandler{
		streamRegistry:     deps.StreamRegistry,
		interjectionRouter: deps.InterjectionRouter,
		activeTurnRegistry: deps.ActiveTurnRegistry,
		turnStreamStarter:  deps.TurnStreamStarter,
		turnReader:         deps.TurnReader,
		authorizer:         deps.Authorizer,
		logger:             logger,
	}
}

func (h *TurnStreamHandler) OnConnect(session wsutil.Session) (wsutil.State, error) {
	return &turnStreamState{
		session:   session,
		liveFeeds: make(map[string]*liveFeed),
		turnSubs:  make(map[string]string),
	}, nil
}

func (h *TurnStreamHandler) OnSubscribe(rawState wsutil.State, sub wsutil.SubscribeRequest) error {
	state, err := h.requireState(rawState)
	if err != nil {
		return err
	}

	turnID := strings.TrimSpace(sub.Resource.Id)
	if turnID == "" {
		return fmt.Errorf("turn id is required")
	}

	if oldSubID := h.findSubByTurn(state, turnID); oldSubID != "" && oldSubID != sub.SubId {
		state.session.EndSub(oldSubID)
	}

	if err := h.canAccessTurn(state.session, turnID); err != nil {
		return fmt.Errorf("failed to authorize turn subscription")
	}
	if h.streamRegistry == nil {
		return fmt.Errorf("stream registry unavailable")
	}

	stream := h.streamRegistry.Get(turnID)
	if stream == nil {
		return h.subscribeWithoutStream(state, sub, turnID)
	}

	return h.subscribeWithStream(state, sub, turnID, stream)
}

func (h *TurnStreamHandler) OnUnsubscribe(rawState wsutil.State, subID string) error {
	state, err := h.requireState(rawState)
	if err != nil {
		return nil
	}

	feed := h.detachFeed(state, subID)
	if feed == nil {
		return nil
	}

	feed.cancel()
	feed.stream.RemoveClient(subID)
	return nil
}

func (h *TurnStreamHandler) OnMessage(rawState wsutil.State, msg wsutil.Envelope) error {
	state, err := h.requireState(rawState)
	if err != nil {
		return err
	}
	if msg.Resource == nil || strings.TrimSpace(msg.Resource.Id) == "" {
		return fmt.Errorf("resource id is required")
	}

	turnID := strings.TrimSpace(msg.Resource.Id)
	if _, err := uuid.Parse(turnID); err != nil {
		return fmt.Errorf("invalid turn id")
	}
	if err := h.canAccessTurn(state.session, turnID); err != nil {
		return fmt.Errorf("failed to authorize turn message")
	}

	payload, err := parseWSInterjectionPayload(msg.Payload)
	if err != nil {
		return err
	}
	if h.interjectionRouter == nil {
		return fmt.Errorf("interjection router unavailable")
	}

	targetTurnID, _, err := h.interjectionRouter.Route(turnID, payload.Content, payload.Mode)
	if err != nil {
		return fmt.Errorf("failed to route interjection")
	}

	buffer := h.interjectionRouter.Register(targetTurnID)
	content, _ := buffer.Peek()

	response := map[string]any{
		"mode":    "queued",
		"content": content,
	}
	return state.session.Send(wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpInterjectionResult,
		Resource: &wsutil.Resource{Type: "turn", Id: turnID},
		Payload:  mustMarshal(response),
	})
}

func (h *TurnStreamHandler) OnDisconnect(rawState wsutil.State) {
	state, err := h.requireState(rawState)
	if err != nil {
		return
	}

	state.mu.Lock()
	feeds := make(map[string]*liveFeed, len(state.liveFeeds))
	for subID, feed := range state.liveFeeds {
		feeds[subID] = feed
	}
	state.liveFeeds = make(map[string]*liveFeed)
	state.turnSubs = make(map[string]string)
	state.mu.Unlock()

	for subID, feed := range feeds {
		feed.cancel()
		feed.stream.RemoveClient(subID)
	}
}

func (h *TurnStreamHandler) subscribeWithoutStream(state *turnStreamState, sub wsutil.SubscribeRequest, turnID string) error {
	turn, err := h.loadTurn(turnID)
	if err != nil {
		return fmt.Errorf("failed to subscribe")
	}

	switch turn.Status {
	case domainllm.TurnStatusComplete, domainllm.TurnStatusCancelled, domainllm.TurnStatusError, domainllm.TurnStatusCreditLimited:
		finalSeq := parseFinalSeqFromTurn(turn)
		if err := h.sendSubscribed(state.session, sub, "", finalSeq, false, 0); err != nil {
			return err
		}

		reason, newAssistantTurnID := endedReasonFromTurn(turn, "")
		if err := h.sendEnded(state.session, sub.SubId, turnID, finalSeq, "", reason, newAssistantTurnID); err != nil {
			return err
		}
		state.session.EndSub(sub.SubId)
		return nil
	case domainllm.TurnStatusPending, domainllm.TurnStatusWaitingSubagents:
		h.bindTurnToSub(state, turnID, sub.SubId)
		return h.sendSubscribed(state.session, sub, "", 0, false, 0)
	case domainllm.TurnStatusStreaming:
		if err := h.sendGap(state.session, sub.SubId, turnID, sub.LastSeq, 0, "server_restart"); err != nil {
			return err
		}
		state.session.EndSub(sub.SubId)
		return nil
	default:
		h.bindTurnToSub(state, turnID, sub.SubId)
		return h.sendSubscribed(state.session, sub, "", 0, false, 0)
	}
}

func (h *TurnStreamHandler) subscribeWithStream(state *turnStreamState, sub wsutil.SubscribeRequest, turnID string, stream *mstream.Stream) error {
	lastSeq := int64(0)
	if sub.LastSeq != nil {
		lastSeq = *sub.LastSeq
	}
	epoch := ""
	if sub.Epoch != nil {
		epoch = *sub.Epoch
	}

	catchup, liveChan, status, err := stream.SubscribeWithCatchup(sub.SubId, lastSeq, epoch)
	if err != nil {
		cause := "buffer_expired"
		switch {
		case errors.Is(err, mstream.ErrEpochMismatch):
			cause = "epoch_mismatch"
		case errors.Is(err, mstream.ErrSequenceNotFound):
			cause = "buffer_expired"
		}
		if gapErr := h.sendGap(state.session, sub.SubId, turnID, sub.LastSeq, 0, cause); gapErr != nil {
			return gapErr
		}
		state.session.EndSub(sub.SubId)
		return nil
	}

	headSeq := headSeqFromCatchup(catchup, lastSeq)
	recovered := sub.LastSeq != nil || sub.Epoch != nil
	if err := h.sendSubscribed(state.session, sub, stream.Epoch(), headSeq, recovered, len(catchup)); err != nil {
		return err
	}
	if err := h.sendCatchup(state.session, sub.SubId, turnID, stream.Epoch(), catchup, lastSeq); err != nil {
		return err
	}

	if isTerminalStreamStatus(status) {
		reason, newAssistantTurnID := h.resolveEndedReason(turnID, stream.Status())
		if err := h.sendEnded(state.session, sub.SubId, turnID, headSeq, stream.Epoch(), reason, newAssistantTurnID); err != nil {
			return err
		}
		state.session.EndSub(sub.SubId)
		return nil
	}

	h.bindTurnToSub(state, turnID, sub.SubId)
	ctx, cancel := context.WithCancel(context.Background())
	feed := &liveFeed{
		turnID:   turnID,
		stream:   stream,
		liveChan: liveChan,
		ctx:      ctx,
		cancel:   cancel,
		headSeq:  headSeq,
	}

	state.mu.Lock()
	state.liveFeeds[sub.SubId] = feed
	state.mu.Unlock()

	go h.runLiveFeed(state, sub.SubId, feed)
	return nil
}

func (h *TurnStreamHandler) runLiveFeed(state *turnStreamState, subID string, feed *liveFeed) {
	defer func() {
		if recovered := recover(); recovered != nil {
			h.logger.Error("thread ws live feed panic",
				"sub_id", subID,
				"turn_id", feed.turnID,
				"panic", recovered,
				"stack", string(debug.Stack()),
			)
			_ = h.detachFeed(state, subID)
			state.session.EndSub(subID)
		}
	}()

	epoch := feed.stream.Epoch()
	lastSeq := feed.headSeq

	for {
		select {
		case <-feed.ctx.Done():
			return
		case event, ok := <-feed.liveChan:
			if !ok {
				reason, newAssistantTurnID := h.resolveEndedReason(feed.turnID, feed.stream.Status())
				if err := h.sendEnded(state.session, subID, feed.turnID, lastSeq, epoch, reason, newAssistantTurnID); err != nil {
					h.logger.Debug("failed to send ended event",
						"sub_id", subID,
						"turn_id", feed.turnID,
						"error", err,
					)
				}
				state.session.EndSub(subID)
				return
			}

			env, seq := toStreamEnvelope(subID, feed.turnID, epoch, event, lastSeq)
			if err := state.session.SendToSub(subID, env); err != nil {
				return
			}
			lastSeq = seq
		}
	}
}

func parseWSInterjectionPayload(raw json.RawMessage) (*UpsertInterjectionRequest, error) {
	var payload struct {
		Action string `json:"action"`
		Text   string `json:"text"`
		Mode   string `json:"mode"`
	}

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&payload); err != nil {
		return nil, fmt.Errorf("invalid interjection payload")
	}
	if strings.TrimSpace(payload.Action) != "interjection" {
		return nil, fmt.Errorf("unsupported stream.message action")
	}

	req := &UpsertInterjectionRequest{
		Mode:    payload.Mode,
		Content: payload.Text,
	}
	if err := normalizeUpsertInterjectionRequest(req); err != nil {
		return nil, err
	}
	return req, nil
}

func (h *TurnStreamHandler) canAccessTurn(session wsutil.Session, turnID string) error {
	if h.authorizer == nil {
		return fmt.Errorf("authorizer unavailable")
	}

	ctx, cancel := context.WithTimeout(context.Background(), wsHandlerOpTimeout)
	defer cancel()
	return h.authorizer.CanAccessTurn(ctx, session.UserID(), turnID)
}

func (h *TurnStreamHandler) loadTurn(turnID string) (*domainllm.Turn, error) {
	if h.turnReader == nil {
		return nil, fmt.Errorf("turn reader unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), wsHandlerOpTimeout)
	defer cancel()
	return h.turnReader.GetTurn(ctx, turnID)
}

func (h *TurnStreamHandler) resolveEndedReason(turnID string, status mstream.Status) (string, string) {
	turn, err := h.loadTurn(turnID)
	if err != nil {
		switch status {
		case mstream.StatusError:
			return "error", ""
		case mstream.StatusCancelled:
			return "cancelled", ""
		default:
			return "completed", ""
		}
	}
	return endedReasonFromTurn(turn, status)
}

func endedReasonFromTurn(turn *domainllm.Turn, fallback mstream.Status) (string, string) {
	if turn == nil {
		switch fallback {
		case mstream.StatusError:
			return "error", ""
		case mstream.StatusCancelled:
			return "cancelled", ""
		default:
			return "completed", ""
		}
	}

	switch turn.Status {
	case domainllm.TurnStatusCancelled:
		return "cancelled", ""
	case domainllm.TurnStatusError, domainllm.TurnStatusCreditLimited:
		return "error", ""
	case domainllm.TurnStatusComplete:
		stopReason := ""
		if turn.StopReason != nil {
			stopReason = strings.TrimSpace(*turn.StopReason)
		}
		if stopReason == "stream_switch" {
			return "stream_switch", successorTurnID(turn)
		}
		return "completed", ""
	default:
		switch fallback {
		case mstream.StatusError:
			return "error", ""
		case mstream.StatusCancelled:
			return "cancelled", ""
		default:
			return "completed", ""
		}
	}
}

func successorTurnID(turn *domainllm.Turn) string {
	if turn == nil || turn.ResponseMetadata == nil {
		return ""
	}
	raw, ok := turn.ResponseMetadata["successor_turn_id"]
	if !ok {
		return ""
	}
	value, _ := raw.(string)
	return strings.TrimSpace(value)
}

func parseFinalSeqFromTurn(turn *domainllm.Turn) int64 {
	if turn == nil || turn.ResponseMetadata == nil {
		return 0
	}
	raw, ok := turn.ResponseMetadata["last_block_sequence"]
	if !ok {
		return 0
	}
	switch v := raw.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	default:
		return 0
	}
}

func (h *TurnStreamHandler) sendSubscribed(session wsutil.Session, sub wsutil.SubscribeRequest, epoch string, headSeq int64, recovered bool, catchupCount int) error {
	return session.Send(wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribed,
		SubId:    sub.SubId,
		Resource: &wsutil.Resource{Type: sub.Resource.Type, Id: sub.Resource.Id},
		Epoch:    epoch,
		Payload: mustMarshal(map[string]any{
			"headSeq":      headSeq,
			"recovered":    recovered,
			"catchupCount": catchupCount,
		}),
	})
}

func (h *TurnStreamHandler) sendCatchup(
	session wsutil.Session,
	subID string,
	turnID string,
	epoch string,
	catchup []mstream.Event,
	lastSeq int64,
) error {
	current := lastSeq
	for _, event := range catchup {
		env, seq := toStreamEnvelope(subID, turnID, epoch, event, current)
		if err := session.SendToSub(subID, env); err != nil {
			return err
		}
		current = seq
	}
	return nil
}

func (h *TurnStreamHandler) sendEnded(
	session wsutil.Session,
	subID string,
	turnID string,
	finalSeq int64,
	epoch string,
	reason string,
	newAssistantTurnID string,
) error {
	payload := map[string]any{
		"reason":   reason,
		"finalSeq": finalSeq,
	}
	if newAssistantTurnID != "" {
		payload["newAssistantTurnId"] = newAssistantTurnID
	}

	return session.SendToSub(subID, wsutil.Envelope{
		Kind:     wsutil.KindStream,
		Op:       wsutil.OpEnded,
		SubId:    subID,
		Resource: &wsutil.Resource{Type: "turn", Id: turnID},
		Seq:      finalSeq,
		Epoch:    epoch,
		Payload:  mustMarshal(payload),
	})
}

func (h *TurnStreamHandler) sendGap(
	session wsutil.Session,
	subID string,
	turnID string,
	fromSeq *int64,
	toSeq int64,
	cause string,
) error {
	start := int64(0)
	if fromSeq != nil {
		start = *fromSeq
	}
	return session.SendToSub(subID, wsutil.Envelope{
		Kind:     wsutil.KindStream,
		Op:       wsutil.OpGap,
		SubId:    subID,
		Resource: &wsutil.Resource{Type: "turn", Id: turnID},
		Payload: mustMarshal(map[string]any{
			"fromSeq": start,
			"toSeq":   toSeq,
			"cause":   cause,
		}),
	})
}

func toStreamEnvelope(subID, turnID, epoch string, event mstream.Event, previousSeq int64) (wsutil.Envelope, int64) {
	seq := previousSeq
	if parsed, err := strconv.ParseInt(strings.TrimSpace(event.ID), 10, 64); err == nil {
		seq = parsed
	} else if seq >= 0 {
		seq++
	}

	return wsutil.Envelope{
		Kind:     wsutil.KindStream,
		Op:       wsutil.OpEvent,
		SubId:    subID,
		Resource: &wsutil.Resource{Type: "turn", Id: turnID},
		Seq:      seq,
		Epoch:    epoch,
		Payload:  event.Data,
	}, seq
}

func headSeqFromCatchup(catchup []mstream.Event, fallback int64) int64 {
	seq := fallback
	for _, event := range catchup {
		parsed, err := strconv.ParseInt(strings.TrimSpace(event.ID), 10, 64)
		if err == nil && parsed > seq {
			seq = parsed
		}
	}
	return seq
}

func isTerminalStreamStatus(status mstream.StreamStatus) bool {
	switch status {
	case mstream.StatusComplete, mstream.StatusCancelled, mstream.StatusError:
		return true
	default:
		return false
	}
}

func (h *TurnStreamHandler) requireState(raw wsutil.State) (*turnStreamState, error) {
	state, ok := raw.(*turnStreamState)
	if !ok || state == nil {
		return nil, fmt.Errorf("invalid turn stream state")
	}
	return state, nil
}

func (h *TurnStreamHandler) bindTurnToSub(state *turnStreamState, turnID, subID string) {
	state.mu.Lock()
	state.turnSubs[turnID] = subID
	state.mu.Unlock()
}

func (h *TurnStreamHandler) findSubByTurn(state *turnStreamState, turnID string) string {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.turnSubs[turnID]
}

func (h *TurnStreamHandler) detachFeed(state *turnStreamState, subID string) *liveFeed {
	state.mu.Lock()
	defer state.mu.Unlock()

	feed := state.liveFeeds[subID]
	delete(state.liveFeeds, subID)

	for turnID, boundSubID := range state.turnSubs {
		if boundSubID == subID {
			delete(state.turnSubs, turnID)
		}
	}
	return feed
}

func mustMarshal(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}
