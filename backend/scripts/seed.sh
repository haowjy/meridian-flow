#!/bin/bash

# Seed database via API using JSON files from seed_data/
# Usage:
#   ./scripts/seed.sh              # Seed with existing data
#   ./scripts/seed.sh --drop-tables # Drop tables and seed fresh

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PORT=8080
API_URL="http://localhost:$PORT"
SEED_DATA_DIR="scripts/seed_data"
SERVER_STARTED=false

# Parse arguments
DROP_TABLES=false
if [[ "$1" == "--drop-tables" ]]; then
    DROP_TABLES=true
fi

echo -e "${GREEN}🌱 Seeding database via API${NC}"

# Step 1: Drop tables if requested
if [ "$DROP_TABLES" = true ]; then
    echo -e "${YELLOW}🗑️  Dropping all tables and recreating schema...${NC}"
    go run ./cmd/seed/main.go --drop-tables --schema-only 2>&1 | grep -E "(✅|✓|❌|Dropping|Schema)"
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Schema reset complete${NC}"
        # Wait for connection pool to fully close to avoid prepared statement conflicts
        sleep 2
    else
        echo -e "${YELLOW}⚠️  Schema script not available, continuing...${NC}"
    fi
fi

# Step 2: Check if server is running
echo -e "${YELLOW}🔍 Checking if server is running on port $PORT...${NC}"
if curl -s "$API_URL/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Server is already running${NC}"
else
    echo -e "${YELLOW}🚀 Starting server...${NC}"
    go run ./cmd/server/main.go > /tmp/meridian-seed-server.log 2>&1 &
    SERVER_PID=$!
    SERVER_STARTED=true

    # Wait for server to start (max 10 seconds)
    for i in {1..20}; do
        if curl -s "$API_URL/health" > /dev/null 2>&1; then
            echo -e "${GREEN}✅ Server started (PID: $SERVER_PID)${NC}"
            break
        fi
        if [ $i -eq 20 ]; then
            echo -e "${RED}❌ Server failed to start within 10 seconds${NC}"
            cat /tmp/meridian-seed-server.log
            exit 1
        fi
        sleep 0.5
    done
fi

# Step 3: Seed documents from JSON files
echo -e "${YELLOW}📝 Seeding documents from $SEED_DATA_DIR/...${NC}"

if [ ! -d "$SEED_DATA_DIR" ]; then
    echo -e "${RED}❌ Seed data directory not found: $SEED_DATA_DIR${NC}"
    exit 1
fi

# Count total files
TOTAL_FILES=$(find "$SEED_DATA_DIR" -name "*.json" | wc -l | tr -d ' ')
if [ "$TOTAL_FILES" -eq 0 ]; then
    echo -e "${YELLOW}⚠️  No .json files found in $SEED_DATA_DIR${NC}"
    exit 0
fi

echo -e "${GREEN}Found $TOTAL_FILES document(s) to seed${NC}"

# Create each document
SUCCESS_COUNT=0
FAIL_COUNT=0

while IFS= read -r json_file; do
    FILENAME=$(basename "$json_file")

    # POST to API
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/documents" \
        -H "Content-Type: application/json" \
        -d @"$json_file")

    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" -eq 201 ]; then
        # Extract name and ID from response
        NAME=$(echo "$BODY" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
        ID=$(echo "$BODY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo -e "${GREEN}✅ Created: $NAME (from $FILENAME)${NC}"
        ((SUCCESS_COUNT++))
    else
        echo -e "${RED}❌ Failed: $FILENAME (HTTP $HTTP_CODE)${NC}"
        echo -e "${RED}   Response: $BODY${NC}"
        ((FAIL_COUNT++))
    fi
done < <(find "$SEED_DATA_DIR" -name "*.json" | sort)

# Step 4: Cleanup
if [ "$SERVER_STARTED" = true ]; then
    echo -e "${YELLOW}🛑 Stopping server (PID: $SERVER_PID)...${NC}"
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
    echo -e "${GREEN}✅ Server stopped${NC}"
fi

# Summary
echo ""
echo -e "${GREEN}🎉 Seeding complete!${NC}"
echo -e "   Success: ${GREEN}$SUCCESS_COUNT${NC}"
if [ "$FAIL_COUNT" -gt 0 ]; then
    echo -e "   Failed:  ${RED}$FAIL_COUNT${NC}"
fi
