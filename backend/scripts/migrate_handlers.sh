#!/bin/bash
# Script to mechanically migrate Fiber handlers to standard HTTP
# This performs the repetitive search/replace, then manual review is needed

set -e

HANDLERS=(
    "document.go"
    "folder.go"
    "import.go"
    "chat.go"
    "chat_debug.go"
)

cd "$(dirname "$0")/../internal/handler"

for handler in "${HANDLERS[@]}"; do
    echo "Migrating $handler..."

    # Backup
    cp "$handler" "${handler}.bak"

    # Import changes
    sed -i '' 's|"github.com/gofiber/fiber/v2"|"net/http"\n\n\t"meridian/internal/httputil"|g' "$handler"

    # Function signature changes
    sed -i '' 's|(c \*fiber\.Ctx) error|(w http.ResponseWriter, r *http.Request)|g' "$handler"

    # Context helpers
    sed -i '' 's|getUserID(c)|getUserID(r)|g' "$handler"
    sed -i '' 's|getProjectID(c)|getProjectID(r)|g' "$handler"

    # Request parsing
    sed -i '' 's|c\.BodyParser(\&|httputil.ParseJSON(r, \&|g' "$handler"
    sed -i '' 's|c\.Params(|r.PathValue(|g' "$handler"
    sed -i '' 's|c\.Query(|r.URL.Query().Get(|g' "$handler"
    sed -i '' 's|c\.QueryInt(|strconv.Atoi(r.URL.Query().Get(|g' "$handler"

    # Response writing
    sed -i '' 's|return c\.JSON(|httputil.RespondJSON(w, http.StatusOK, |g' "$handler"
    sed -i '' 's|return c\.Status(fiber\.StatusCreated)\.JSON(|httputil.RespondJSON(w, http.StatusCreated, |g' "$handler"
    sed -i '' 's|return c\.SendStatus(|w.WriteHeader(|g' "$handler"

    # Error handling
    sed -i '' 's|return fiber\.NewError(fiber\.StatusBadRequest,|httputil.RespondError(w, http.StatusBadRequest,|g' "$handler"
    sed -i '' 's|return fiber\.NewError(fiber\.StatusUnauthorized,|httputil.RespondError(w, http.StatusUnauthorized,|g' "$handler"
    sed -i '' 's|return fiber\.NewError(fiber\.StatusNotFound,|httputil.RespondError(w, http.StatusNotFound,|g' "$handler"
    sed -i '' 's|return handleError(c,|handleError(w,|g' "$handler"

    # Context access
    sed -i '' 's|c\.Context()|r.Context()|g' "$handler"
    sed -i '' 's|c\.IP()|r.RemoteAddr|g' "$handler"
    sed -i '' 's|c\.Get(|r.Header.Get(|g' "$handler"
    sed -i '' 's|c\.Set(|w.Header().Set(|g' "$handler"

    echo "  ✓ Mechanical migration complete, manual review needed"
done

echo ""
echo "Migration complete! Review each file and:"
echo "1. Add 'return' after error responses"
echo "2. Fix any broken syntax"
echo "3. Update remaining Fiber-specific code"
echo "4. Remove .bak files when satisfied"
