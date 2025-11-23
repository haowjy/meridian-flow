#!/bin/bash
# Update Library Versions and Sync with Backend
# Auto-increments patch versions (v0.0.1 → v0.0.2)
# Usage: ./scripts/update-libraries.sh [commit-message]

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get commit message from argument or prompt
COMMIT_MSG="${1:-Update libraries}"

echo -e "${BLUE}=== Library Update Script ===${NC}"
echo -e "Commit message: ${YELLOW}$COMMIT_MSG${NC}\n"

# Function to get latest tag from a git repo
get_latest_tag() {
    local repo_path=$1
    cd "$repo_path"

    # Get latest tag (sorted by version)
    local latest=$(git tag -l "v*" | sort -V | tail -n 1)

    if [ -z "$latest" ]; then
        echo "v0.0.0"  # Default if no tags exist
    else
        echo "$latest"
    fi
}

# Function to increment patch version (v0.0.1 → v0.0.2)
increment_patch() {
    local version=$1
    # Remove 'v' prefix
    version=${version#v}

    # Split into major.minor.patch
    IFS='.' read -r major minor patch <<< "$version"

    # Increment patch
    patch=$((patch + 1))

    echo "v${major}.${minor}.${patch}"
}

# Function to update a library
update_library() {
    local lib_name=$1
    local lib_path=$2
    local github_path=$3

    echo -e "\n${BLUE}=== Updating ${lib_name} ===${NC}"

    cd "$lib_path"

    # Check for uncommitted changes
    if ! git diff-index --quiet HEAD --; then
        echo -e "${YELLOW}Found uncommitted changes${NC}"
        git status -s

        read -p "Commit these changes? (y/n): " commit_confirm
        if [ "$commit_confirm" != "y" ]; then
            echo -e "${RED}Skipping ${lib_name}${NC}"
            return 1
        fi

        git add .
        git commit -m "$COMMIT_MSG"
    else
        echo -e "${GREEN}No uncommitted changes${NC}"
        read -p "Tag current commit anyway? (y/n): " tag_anyway
        if [ "$tag_anyway" != "y" ]; then
            echo -e "${YELLOW}Skipping ${lib_name}${NC}"
            return 1
        fi
    fi

    # Get current version and calculate next
    CURRENT_TAG=$(get_latest_tag ".")
    NEXT_TAG=$(increment_patch "$CURRENT_TAG")

    echo -e "Current version: ${YELLOW}${CURRENT_TAG}${NC}"
    echo -e "Next version:    ${GREEN}${NEXT_TAG}${NC}"

    read -p "Use this version? (y/n/custom): " version_confirm

    if [ "$version_confirm" = "custom" ]; then
        read -p "Enter custom version (e.g., v0.1.0): " NEXT_TAG
    elif [ "$version_confirm" != "y" ]; then
        echo -e "${YELLOW}Skipping ${lib_name}${NC}"
        return 1
    fi

    # Verify tag doesn't already exist
    if git rev-parse "$NEXT_TAG" >/dev/null 2>&1; then
        echo -e "${RED}Error: Tag ${NEXT_TAG} already exists!${NC}"
        return 1
    fi

    # Tag and push
    echo -e "${GREEN}Creating tag ${NEXT_TAG}${NC}"
    git tag "$NEXT_TAG"

    echo "Pushing to GitHub..."
    git push origin main
    git push origin "$NEXT_TAG"

    echo -e "${GREEN}✓ ${lib_name} updated to ${NEXT_TAG}${NC}"

    # Return new version for backend update
    echo "$github_path@$NEXT_TAG"
}

# Navigate to repo root
cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

# Update meridian-llm-go
LLM_UPDATE=$(update_library \
    "meridian-llm-go" \
    "$REPO_ROOT/meridian-llm-go" \
    "github.com/haowjy/meridian-llm-go" \
) || LLM_UPDATE=""

# Update meridian-stream-go
STREAM_UPDATE=$(update_library \
    "meridian-stream-go" \
    "$REPO_ROOT/meridian-stream-go" \
    "github.com/haowjy/meridian-stream-go" \
) || STREAM_UPDATE=""

# Check if any libraries were updated
if [ -z "$LLM_UPDATE" ] && [ -z "$STREAM_UPDATE" ]; then
    echo -e "\n${YELLOW}No libraries updated. Exiting.${NC}"
    exit 0
fi

# Update backend dependencies
echo -e "\n${BLUE}=== Updating Backend Dependencies ===${NC}"
cd "$REPO_ROOT/backend"

if [ -n "$LLM_UPDATE" ]; then
    echo -e "Updating: ${GREEN}$LLM_UPDATE${NC}"
    go get "$LLM_UPDATE"
fi

if [ -n "$STREAM_UPDATE" ]; then
    echo -e "Updating: ${GREEN}$STREAM_UPDATE${NC}"
    go get "$STREAM_UPDATE"
fi

echo "Running go mod tidy..."
go mod tidy

echo -e "${GREEN}✓ Backend dependencies updated${NC}"

# Show what changed in go.mod
echo -e "\n${BLUE}=== Changes in go.mod ===${NC}"
git diff go.mod | grep "meridian" || echo "No changes detected"

# Test backend build
echo -e "\n${BLUE}=== Testing Backend Build ===${NC}"
read -p "Run 'go build' test? (y/n): " build_test
if [ "$build_test" = "y" ]; then
    echo "Building..."
    go build ./cmd/server
    echo -e "${GREEN}✓ Build successful${NC}"
fi

# Test Docker build
echo -e "\n${BLUE}=== Testing Docker Build ===${NC}"
read -p "Run 'docker build' test? (y/n): " docker_test
if [ "$docker_test" = "y" ]; then
    echo "Building Docker image (this may take a while)..."
    docker build --no-cache -t meridian-backend .
    echo -e "${GREEN}✓ Docker build successful${NC}"
fi

# Summary
echo -e "\n${GREEN}=== Update Complete ===${NC}"
echo -e "Libraries updated:"
[ -n "$LLM_UPDATE" ] && echo -e "  - ${GREEN}$LLM_UPDATE${NC}"
[ -n "$STREAM_UPDATE" ] && echo -e "  - ${GREEN}$STREAM_UPDATE${NC}"

echo -e "\n${YELLOW}Next steps:${NC}"
echo "1. Review changes: git diff backend/go.mod backend/go.sum"
echo "2. Commit backend changes:"
echo "   cd backend"
echo "   git add go.mod go.sum"
echo "   git commit -m 'Update library dependencies'"
echo "3. Push to trigger Railway deployment:"
echo "   git push origin main"

echo -e "\n${BLUE}Rollback instructions (if needed):${NC}"
[ -n "$LLM_UPDATE" ] && echo "  go get ${LLM_UPDATE%@*}@<previous-version>"
[ -n "$STREAM_UPDATE" ] && echo "  go get ${STREAM_UPDATE%@*}@<previous-version>"
echo "  go mod tidy"
