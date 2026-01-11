package tools

// NOTE: RegisterReadOnlyTools was removed in Phase 2 of the service layer migration.
// The function was deprecated and unused. All tools now use service layer for data access.
//
// Use ToolRegistryBuilder.WithDocumentTools() instead for registering document tools.
// Example:
//   registry := tools.NewToolRegistryBuilder().
//       WithDocumentTools(projectID, userID, documentRepo, folderRepo, documentSvc, folderSvc).
//       Build()
