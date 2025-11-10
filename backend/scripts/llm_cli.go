package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"meridian/internal/config"
	llmModels "meridian/internal/domain/models/llm"
	domainLLMRepo "meridian/internal/domain/repositories/llm"
	llmDomain "meridian/internal/domain/services/llm"
	"meridian/internal/repository/postgres"
	docsysRepo "meridian/internal/repository/postgres/docsystem"
	llmRepo "meridian/internal/repository/postgres/llm"
	llmService "meridian/internal/service/llm"
)

// ANSI color codes
const (
	colorReset  = "\033[0m"
	colorGreen  = "\033[32m"
	colorRed    = "\033[31m"
	colorBlue   = "\033[34m"
	colorYellow = "\033[33m"
	colorCyan   = "\033[36m"
)

type CLI struct {
	ctx       context.Context
	chatSvc   llmDomain.ChatService
	chatRepo  domainLLMRepo.ChatRepository
	turnRepo  domainLLMRepo.TurnRepository
	scanner   *bufio.Scanner
	projectID string
	userID    string
	logger    *slog.Logger
}

// setupLogger creates a logger that writes to both console and file
func setupLogger() (*slog.Logger, string, error) {
	// Create logs directory
	logsDir := "logs"
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		return nil, "", fmt.Errorf("failed to create logs directory: %w", err)
	}

	// Generate timestamped log filename
	timestamp := time.Now().Format("2006-01-02_15-04-05")
	logFilename := filepath.Join(logsDir, fmt.Sprintf("llm_cli_%s.log", timestamp))

	// Open log file
	logFile, err := os.Create(logFilename)
	if err != nil {
		return nil, "", fmt.Errorf("failed to create log file: %w", err)
	}

	// Create handlers
	// Console: INFO level, text format
	consoleHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})

	// File: DEBUG level, formatted text for readability
	fileHandler := slog.NewTextHandler(logFile, &slog.HandlerOptions{
		Level:     slog.LevelDebug,
		AddSource: true,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Format time for better readability
			if a.Key == slog.TimeKey {
				if t, ok := a.Value.Any().(time.Time); ok {
					return slog.String(slog.TimeKey, t.Format("2006-01-02 15:04:05"))
				}
			}
			// Format source for better readability
			if a.Key == slog.SourceKey {
				if src, ok := a.Value.Any().(*slog.Source); ok {
					return slog.String(slog.SourceKey, fmt.Sprintf("%s:%d", filepath.Base(src.File), src.Line))
				}
			}
			return a
		},
	})

	// Multi-handler: writes to both console and file
	multiHandler := &multiHandler{
		handlers: []slog.Handler{consoleHandler, fileHandler},
	}

	logger := slog.New(multiHandler)
	return logger, logFilename, nil
}

// multiHandler writes to multiple handlers
type multiHandler struct {
	handlers []slog.Handler
}

func (h *multiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (h *multiHandler) Handle(ctx context.Context, record slog.Record) error {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, record.Level) {
			if err := handler.Handle(ctx, record); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	handlers := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		handlers[i] = handler.WithAttrs(attrs)
	}
	return &multiHandler{handlers: handlers}
}

func (h *multiHandler) WithGroup(name string) slog.Handler {
	handlers := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		handlers[i] = handler.WithGroup(name)
	}
	return &multiHandler{handlers: handlers}
}

func main() {
	// Setup dual logger (console + file)
	logger, logFile, err := setupLogger()
	if err != nil {
		fmt.Printf("Failed to setup logger: %v\n", err)
		os.Exit(1)
	}
	logger.Info("session started", "log_file", logFile)

	// Load config
	cfg := config.Load()

	// Get test IDs from environment
	projectID := os.Getenv("TEST_PROJECT_ID")
	userID := os.Getenv("TEST_USER_ID")

	logger.Debug("loaded environment variables",
		"project_id", projectID,
		"user_id", userID,
	)

	if projectID == "" || userID == "" {
		logger.Error("missing required environment variables")
		fmt.Printf("%s❌ Error: TEST_PROJECT_ID and TEST_USER_ID must be set in environment%s\n", colorRed, colorReset)
		os.Exit(1)
	}

	// Connect to database
	ctx := context.Background()
	logger.Debug("connecting to database", "url", cfg.SupabaseDBURL)
	pool, err := postgres.CreateConnectionPool(ctx, cfg.SupabaseDBURL)
	if err != nil {
		logger.Error("database connection failed", "error", err)
		fmt.Printf("%s❌ Failed to connect to database: %v%s\n", colorRed, err, colorReset)
		os.Exit(1)
	}
	defer pool.Close()
	logger.Info("database connected")

	// Setup repositories
	tables := postgres.NewTableNames(cfg.TablePrefix)
	repoConfig := &postgres.RepositoryConfig{
		Pool:   pool,
		Tables: tables,
		Logger: logger,
	}

	turnRepo := llmRepo.NewTurnRepository(repoConfig)
	chatRepo := llmRepo.NewChatRepository(repoConfig)
	projectRepo := docsysRepo.NewProjectRepository(repoConfig)

	// Setup LLM services
	logger.Debug("setting up LLM providers")
	registry, err := llmService.SetupProviders(cfg, logger)
	if err != nil {
		logger.Error("failed to setup LLM providers", "error", err)
		fmt.Printf("%s❌ Failed to setup providers: %v%s\n", colorRed, err, colorReset)
		os.Exit(1)
	}
	logger.Info("LLM providers initialized")

	logger.Debug("initializing chat services")
	responseGen := llmService.NewResponseGenerator(registry, turnRepo, logger)
	validator := llmService.NewChatValidator(chatRepo)
	chatSvc := llmService.NewChatService(
		chatRepo,
		turnRepo,
		projectRepo,
		validator,
		responseGen,
		llmService.GetGlobalRegistry(),
		logger,
	)
	logger.Info("chat services initialized")

	// Create CLI
	cli := &CLI{
		ctx:       context.Background(),
		chatSvc:   chatSvc,
		chatRepo:  chatRepo,
		turnRepo:  turnRepo,
		scanner:   bufio.NewScanner(os.Stdin),
		projectID: projectID,
		userID:    userID,
		logger:    logger,
	}

	// Run main loop
	cli.run()
}

func (cli *CLI) run() {
	cli.logger.Info("CLI started",
		"project_id", cli.projectID,
		"user_id", cli.userID,
	)

	fmt.Printf("\n%s╔══════════════════════════════════════╗%s\n", colorCyan, colorReset)
	fmt.Printf("%s║    Meridian LLM Test CLI v1.0        ║%s\n", colorCyan, colorReset)
	fmt.Printf("%s╚══════════════════════════════════════╝%s\n", colorCyan, colorReset)
	fmt.Printf("%sProject: %s | User: %s%s\n\n", colorBlue, cli.projectID, cli.userID, colorReset)

	for {
		fmt.Println("\n" + strings.Repeat("─", 40))
		fmt.Println("Main Menu:")
		fmt.Println("1. Create new chat and send message")
		fmt.Println("2. View chat history")
		fmt.Println("3. Continue existing conversation")
		fmt.Println("4. Exit")
		fmt.Print("\nSelect option (1-4): ")

		choice := cli.readLine()
		fmt.Println() // Extra line for spacing

		cli.logger.Debug("menu selection", "choice", choice)

		switch choice {
		case "1":
			cli.newChatFlow()
		case "2":
			cli.viewChatHistory()
		case "3":
			cli.continueConversation()
		case "4":
			cli.logger.Info("CLI exiting")
			fmt.Printf("%s✓ Goodbye!%s\n", colorGreen, colorReset)
			return
		default:
			cli.logger.Warn("invalid menu choice", "choice", choice)
			fmt.Printf("%s⚠ Invalid choice. Please enter 1-4.%s\n", colorYellow, colorReset)
		}
	}
}

func (cli *CLI) newChatFlow() {
	cli.logger.Info("starting new chat flow")
	fmt.Printf("%s=== Create New Chat ===%s\n\n", colorCyan, colorReset)

	// Get chat title
	fmt.Print("Chat title: ")
	title := cli.readLine()
	if title == "" {
		title = "Test Chat"
	}
	cli.logger.Debug("chat title entered", "title", title)

	// Get message
	fmt.Print("Your message: ")
	message := cli.readLine()
	if message == "" {
		cli.logger.Warn("empty message provided")
		fmt.Printf("%s⚠ Message cannot be empty%s\n", colorYellow, colorReset)
		return
	}
	cli.logger.Debug("message entered", "length", len(message))

	// Ask about customization
	fmt.Print("\nCustomize parameters? (y/n): ")
	customize := strings.ToLower(cli.readLine())

	var requestParams map[string]interface{}
	if customize == "y" || customize == "yes" {
		cli.logger.Debug("building custom request parameters")
		requestParams = cli.buildRequestParams()
		cli.logger.Debug("request parameters built", "params", requestParams)
	}

	// Create chat
	fmt.Printf("\n%s⏳ Creating chat...%s\n", colorBlue, colorReset)
	cli.logger.Debug("creating chat",
		"project_id", cli.projectID,
		"user_id", cli.userID,
		"title", title,
	)
	chat, err := cli.chatSvc.CreateChat(cli.ctx, &llmDomain.CreateChatRequest{
		ProjectID: cli.projectID,
		UserID:    cli.userID,
		Title:     title,
	})
	if err != nil {
		cli.logger.Error("failed to create chat",
			"error", err,
			"project_id", cli.projectID,
		)
		fmt.Printf("%s❌ Failed to create chat: %v%s\n", colorRed, err, colorReset)
		return
	}
	cli.logger.Info("chat created", "chat_id", chat.ID)
	fmt.Printf("%s✓ Chat created: %s%s\n", colorGreen, chat.ID, colorReset)

	// Send message
	fmt.Printf("%s⏳ Sending message and waiting for response...%s\n", colorBlue, colorReset)
	cli.logger.Debug("creating user turn",
		"chat_id", chat.ID,
		"message_length", len(message),
		"has_params", requestParams != nil,
	)
	turn, err := cli.chatSvc.CreateTurn(cli.ctx, &llmDomain.CreateTurnRequest{
		ChatID: chat.ID,
		UserID: cli.userID,
		Role:   "user",
		TurnBlocks: []llmDomain.TurnBlockInput{
			{
				BlockType:   "text",
				TextContent: &message,
			},
		},
		RequestParams: requestParams,
	})

	if err != nil {
		cli.logger.Error("failed to create turn",
			"error", err,
			"chat_id", chat.ID,
		)
		fmt.Printf("%s❌ Error: %v%s\n", colorRed, err, colorReset)
		return
	}

	cli.logger.Info("user turn created", "turn_id", turn.UserTurn.ID)
	fmt.Printf("%s✓ User turn created: %s%s\n", colorGreen, turn.UserTurn.ID, colorReset)

	// Get assistant response
	cli.displayAssistantResponse(turn.UserTurn.ID)
}

// selectModel prompts user to select a model
func (cli *CLI) selectModel() string {
	fmt.Printf("\n%sSelect model:%s\n", colorCyan, colorReset)
	fmt.Println("1. Claude Haiku 4.5 (Latest) [default]")
	fmt.Println("2. Claude Sonnet 4.5 (Latest)")
	fmt.Println("3. Claude Opus 4.1")
	fmt.Println("0. Skip (use default)")
	fmt.Print("\nChoice: ")

	choice := cli.readLine()
	cli.logger.Debug("model selection", "choice", choice)

	switch choice {
	case "1", "":
		return "claude-haiku-4-5"
	case "2":
		return "claude-sonnet-4-5"
	case "3":
		return "claude-opus-4-1"
	case "0":
		return ""
	default:
		fmt.Printf("%s⚠ Invalid choice, using default%s\n", colorYellow, colorReset)
		return "claude-haiku-4-5"
	}
}

// selectTemperature prompts user to select a temperature preset
func (cli *CLI) selectTemperature() *float64 {
	fmt.Printf("\n%sSelect temperature:%s\n", colorCyan, colorReset)
	fmt.Println("1. Precise (0.0) - Deterministic, consistent")
	fmt.Println("2. Balanced (0.7) - Good middle ground")
	fmt.Println("3. Creative (1.0) - More varied responses [default]")
	fmt.Println("4. Custom (enter value 0-1)")
	fmt.Println("0. Skip (use default)")
	fmt.Print("\nChoice: ")

	choice := cli.readLine()
	cli.logger.Debug("temperature selection", "choice", choice)

	switch choice {
	case "1":
		val := 0.0
		return &val
	case "2":
		val := 0.7
		return &val
	case "3", "":
		val := 1.0
		return &val
	case "4":
		fmt.Print("Enter temperature (0-1): ")
		tempStr := cli.readLine()
		if val, err := strconv.ParseFloat(tempStr, 64); err == nil {
			if val >= 0 && val <= 1 {
				return &val
			}
			fmt.Printf("%s⚠ Value out of range, using default%s\n", colorYellow, colorReset)
		} else {
			fmt.Printf("%s⚠ Invalid value, using default%s\n", colorYellow, colorReset)
		}
		val := 1.0
		return &val
	case "0":
		return nil
	default:
		fmt.Printf("%s⚠ Invalid choice, using default%s\n", colorYellow, colorReset)
		val := 1.0
		return &val
	}
}

// selectThinking prompts user to select thinking mode settings
func (cli *CLI) selectThinking() (bool, string) {
	fmt.Printf("\n%sEnable thinking mode?%s (y/n): ", colorCyan, colorReset)
	response := strings.ToLower(cli.readLine())

	if response != "y" && response != "yes" {
		cli.logger.Debug("thinking mode disabled")
		return false, ""
	}

	fmt.Printf("\n%sSelect thinking level:%s\n", colorCyan, colorReset)
	fmt.Println("1. Low (2000 tokens) - Quick reasoning")
	fmt.Println("2. Medium (5000 tokens) - Balanced [default]")
	fmt.Println("3. High (12000 tokens) - Deep analysis")
	fmt.Print("\nChoice: ")

	choice := cli.readLine()
	cli.logger.Debug("thinking level selection", "choice", choice)

	var level string
	switch choice {
	case "1":
		level = "low"
	case "2", "":
		level = "medium"
	case "3":
		level = "high"
	default:
		fmt.Printf("%s⚠ Invalid choice, using medium%s\n", colorYellow, colorReset)
		level = "medium"
	}

	return true, level
}

func (cli *CLI) buildRequestParams() map[string]interface{} {
	params := make(map[string]interface{})

	// Model selection (numbered menu)
	model := cli.selectModel()
	if model != "" {
		params["model"] = model
		cli.logger.Debug("model selected", "model", model)
	}

	// Temperature selection (numbered menu)
	temperature := cli.selectTemperature()
	if temperature != nil {
		params["temperature"] = *temperature
		cli.logger.Debug("temperature selected", "temperature", *temperature)
	}

	// Thinking mode selection (numbered menu)
	thinkingEnabled, thinkingLevel := cli.selectThinking()
	if thinkingEnabled {
		params["thinking_enabled"] = true
		params["thinking_level"] = thinkingLevel
		cli.logger.Debug("thinking enabled", "level", thinkingLevel)
	}

	// Max tokens (optional, free text)
	fmt.Print("\nMax tokens (press enter to skip): ")
	maxTokens := cli.readLine()
	if maxTokens != "" {
		if val, err := strconv.Atoi(maxTokens); err == nil {
			params["max_tokens"] = val
			cli.logger.Debug("max tokens set", "max_tokens", val)
		} else {
			fmt.Printf("%s⚠ Invalid number, skipping max_tokens%s\n", colorYellow, colorReset)
		}
	}

	return params
}

func (cli *CLI) viewChatHistory() {
	cli.logger.Info("viewing chat history")
	fmt.Printf("%s=== View Chat History ===%s\n\n", colorCyan, colorReset)

	cli.logger.Debug("listing chats by project",
		"project_id", cli.projectID,
		"user_id", cli.userID,
	)
	chats, err := cli.chatRepo.ListChatsByProject(cli.ctx, cli.projectID, cli.userID)
	if err != nil {
		cli.logger.Error("failed to list chats",
			"error", err,
			"project_id", cli.projectID,
		)
		fmt.Printf("%s❌ Failed to list chats: %v%s\n", colorRed, err, colorReset)
		return
	}

	cli.logger.Debug("chats retrieved", "count", len(chats))

	if len(chats) == 0 {
		cli.logger.Info("no chats found")
		fmt.Printf("%s⚠ No chats found%s\n", colorYellow, colorReset)
		return
	}

	// Display chats
	fmt.Println("Recent chats:")
	for i, chat := range chats {
		fmt.Printf("%d. %s (ID: %s)\n", i+1, chat.Title, chat.ID)
	}

	fmt.Print("\nSelect chat number (or 0 to cancel): ")
	choice := cli.readLine()
	idx, err := strconv.Atoi(choice)
	if err != nil || idx < 1 || idx > len(chats) {
		if idx != 0 {
			cli.logger.Warn("invalid chat selection", "choice", choice)
			fmt.Printf("%s⚠ Invalid choice%s\n", colorYellow, colorReset)
		}
		return
	}

	selectedChat := chats[idx-1]
	cli.logger.Debug("chat selected", "chat_id", selectedChat.ID, "title", selectedChat.Title)
	cli.displayChat(selectedChat.ID)
}

func (cli *CLI) displayChat(chatID string) {
	cli.logger.Debug("displaying chat", "chat_id", chatID)

	// Get root turns for this chat
	cli.logger.Debug("fetching root turns", "chat_id", chatID)
	rootTurns, err := cli.turnRepo.GetRootTurns(cli.ctx, chatID)
	if err != nil {
		cli.logger.Error("failed to get root turns",
			"error", err,
			"chat_id", chatID,
		)
		fmt.Printf("%s❌ Failed to get root turns: %v%s\n", colorRed, err, colorReset)
		return
	}

	cli.logger.Debug("root turns retrieved", "count", len(rootTurns))

	if len(rootTurns) == 0 {
		cli.logger.Warn("no turns found in chat", "chat_id", chatID)
		fmt.Printf("%s⚠ No turns found in this chat%s\n", colorYellow, colorReset)
		return
	}

	// For now, display the first conversation path
	// TODO: Handle branching conversations
	rootTurn := rootTurns[0]

	// Get full path from this root turn
	path, err := cli.turnRepo.GetTurnPath(cli.ctx, rootTurn.ID)
	if err != nil {
		fmt.Printf("%s❌ Failed to get turn path: %v%s\n", colorRed, err, colorReset)
		return
	}

	// Find the last turn in the path
	lastTurnID := rootTurn.ID
	for {
		children, err := cli.turnRepo.GetTurnChildren(cli.ctx, lastTurnID)
		if err != nil || len(children) == 0 {
			break
		}
		lastTurnID = children[0].ID
	}

	// Get full path to last turn
	path, err = cli.turnRepo.GetTurnPath(cli.ctx, lastTurnID)
	if err != nil {
		fmt.Printf("%s❌ Failed to get turn path: %v%s\n", colorRed, err, colorReset)
		return
	}

	// Display each turn
	fmt.Printf("\n%s--- Conversation ---%s\n", colorCyan, colorReset)
	for _, turn := range path {
		cli.displayTurn(&turn)
		fmt.Println()
	}
}

// getProviderName returns the provider name based on model name
func getProviderName(model string) string {
	switch {
	case strings.HasPrefix(model, "claude-"):
		return "Anthropic"
	case strings.HasPrefix(model, "gpt-") || strings.HasPrefix(model, "o1-"):
		return "OpenAI"
	case strings.HasPrefix(model, "gemini-"):
		return "Google"
	default:
		return "Unknown"
	}
}

func (cli *CLI) displayTurn(turn *llmModels.Turn) {
	// Load content blocks
	cli.logger.Debug("loading content blocks for turn", "turn_id", turn.ID)
	blocks, err := cli.turnRepo.GetTurnBlocks(cli.ctx, turn.ID)
	if err != nil {
		cli.logger.Error("failed to load content blocks",
			"error", err,
			"turn_id", turn.ID,
		)
		fmt.Printf("%s❌ Failed to load content blocks: %v%s\n", colorRed, err, colorReset)
		return
	}
	cli.logger.Debug("content blocks loaded", "turn_id", turn.ID, "block_count", len(blocks))

	roleColor := colorBlue
	if turn.Role == "assistant" {
		roleColor = colorGreen
	}

	fmt.Printf("%s[%s]%s\n", roleColor, strings.ToUpper(turn.Role), colorReset)

	// Display content blocks
	for _, block := range blocks {
		switch block.BlockType {
		case llmModels.BlockTypeText:
			if block.TextContent != nil {
				fmt.Println(*block.TextContent)
			}
		case llmModels.BlockTypeThinking:
			if block.TextContent != nil {
				// Show header with character count
				fmt.Printf("%s[Thinking: %d chars]%s\n", colorYellow, len(*block.TextContent), colorReset)

				// Display full thinking content, indented
				lines := strings.Split(*block.TextContent, "\n")
				for _, line := range lines {
					fmt.Printf("%s  %s%s\n", colorYellow, line, colorReset)
				}
			} else {
				// Fallback if no content
				fmt.Printf("%s[Thinking: content not available]%s\n", colorYellow, colorReset)
			}
		}
	}

	// Display metadata for assistant turns
	if turn.Role == "assistant" {
		if turn.InputTokens != nil && turn.OutputTokens != nil {
			tokenInfo := fmt.Sprintf("%s  Tokens: %d in, %d out", colorBlue, *turn.InputTokens, *turn.OutputTokens)

			// Add model and provider if available
			if turn.Model != nil && *turn.Model != "" {
				provider := getProviderName(*turn.Model)
				tokenInfo += fmt.Sprintf(" | Model: %s (%s)", *turn.Model, provider)
			}

			fmt.Printf("%s%s\n", tokenInfo, colorReset)
		}
		if turn.StopReason != nil {
			fmt.Printf("%s  Stop reason: %s%s\n", colorBlue, *turn.StopReason, colorReset)
		}
	}
}

func (cli *CLI) continueConversation() {
	fmt.Printf("%s=== Continue Conversation ===%s\n\n", colorCyan, colorReset)

	chats, err := cli.chatRepo.ListChatsByProject(cli.ctx, cli.projectID, cli.userID)
	if err != nil {
		fmt.Printf("%s❌ Failed to list chats: %v%s\n", colorRed, err, colorReset)
		return
	}

	if len(chats) == 0 {
		fmt.Printf("%s⚠ No chats found%s\n", colorYellow, colorReset)
		return
	}

	// Display chats
	fmt.Println("Select chat to continue:")
	for i, chat := range chats {
		fmt.Printf("%d. %s (ID: %s)\n", i+1, chat.Title, chat.ID)
	}

	fmt.Print("\nSelect chat number (or 0 to cancel): ")
	choice := cli.readLine()
	idx, err := strconv.Atoi(choice)
	if err != nil || idx < 1 || idx > len(chats) {
		if idx != 0 {
			fmt.Printf("%s⚠ Invalid choice%s\n", colorYellow, colorReset)
		}
		return
	}

	selectedChat := chats[idx-1]

	// Display current conversation
	cli.displayChat(selectedChat.ID)

	// Get the last turn ID
	lastTurnID, err := cli.getLastTurnID(selectedChat.ID)
	if err != nil {
		fmt.Printf("%s❌ Failed to find last turn: %v%s\n", colorRed, err, colorReset)
		return
	}

	// Get new message
	fmt.Print("\nYour message: ")
	message := cli.readLine()
	if message == "" {
		fmt.Printf("%s⚠ Message cannot be empty%s\n", colorYellow, colorReset)
		return
	}

	// Ask about customization
	fmt.Print("Customize parameters? (y/n): ")
	customize := strings.ToLower(cli.readLine())

	var requestParams map[string]interface{}
	if customize == "y" || customize == "yes" {
		requestParams = cli.buildRequestParams()
	}

	// Send message
	fmt.Printf("\n%s⏳ Sending message...%s\n", colorBlue, colorReset)
	turn, err := cli.chatSvc.CreateTurn(cli.ctx, &llmDomain.CreateTurnRequest{
		ChatID:     selectedChat.ID,
		UserID:     cli.userID,
		PrevTurnID: &lastTurnID,
		Role:       "user",
		TurnBlocks: []llmDomain.TurnBlockInput{
			{
				BlockType:   "text",
				TextContent: &message,
			},
		},
		RequestParams: requestParams,
	})

	if err != nil {
		fmt.Printf("%s❌ Error: %v%s\n", colorRed, err, colorReset)
		return
	}

	fmt.Printf("%s✓ User turn created: %s%s\n", colorGreen, turn.UserTurn.ID, colorReset)

	// Get assistant response
	cli.displayAssistantResponse(turn.UserTurn.ID)
}

func (cli *CLI) getLastTurnID(chatID string) (string, error) {
	// Get root turns for this chat
	rootTurns, err := cli.turnRepo.GetRootTurns(cli.ctx, chatID)
	if err != nil {
		return "", err
	}

	if len(rootTurns) == 0 {
		return "", fmt.Errorf("no turns found")
	}

	// Traverse to find last turn
	lastTurnID := rootTurns[0].ID
	for {
		children, err := cli.turnRepo.GetTurnChildren(cli.ctx, lastTurnID)
		if err != nil || len(children) == 0 {
			break
		}
		lastTurnID = children[0].ID
	}

	return lastTurnID, nil
}

func (cli *CLI) displayAssistantResponse(userTurnID string) {
	cli.logger.Debug("fetching assistant response", "user_turn_id", userTurnID)

	// Get assistant response
	children, err := cli.turnRepo.GetTurnChildren(cli.ctx, userTurnID)
	if err != nil {
		cli.logger.Error("failed to get assistant turn",
			"error", err,
			"user_turn_id", userTurnID,
		)
		fmt.Printf("%s⚠ No assistant response found: %v%s\n", colorYellow, err, colorReset)
		return
	}

	if len(children) == 0 {
		cli.logger.Warn("no assistant response found yet", "user_turn_id", userTurnID)
		fmt.Printf("%s⚠ No assistant response found (may still be generating)%s\n", colorYellow, colorReset)
		return
	}

	assistantTurn := children[0]
	cli.logger.Debug("assistant response retrieved",
		"assistant_turn_id", assistantTurn.ID,
		"status", assistantTurn.Status,
	)

	fmt.Printf("\n%s--- Assistant Response ---%s\n", colorGreen, colorReset)
	cli.displayTurn(&assistantTurn)

	// Display request params if present
	if assistantTurn.RequestParams != nil && len(assistantTurn.RequestParams) > 0 {
		fmt.Printf("\n%sRequest Parameters:%s\n", colorBlue, colorReset)
		jsonBytes, _ := json.MarshalIndent(assistantTurn.RequestParams, "  ", "  ")
		fmt.Printf("  %s\n", string(jsonBytes))
	}

	// Display response metadata if present
	if assistantTurn.ResponseMetadata != nil && len(assistantTurn.ResponseMetadata) > 0 {
		fmt.Printf("\n%sResponse Metadata:%s\n", colorBlue, colorReset)
		jsonBytes, _ := json.MarshalIndent(assistantTurn.ResponseMetadata, "  ", "  ")
		fmt.Printf("  %s\n", string(jsonBytes))
	}
}

func (cli *CLI) readLine() string {
	if !cli.scanner.Scan() {
		return ""
	}
	return strings.TrimSpace(cli.scanner.Text())
}
