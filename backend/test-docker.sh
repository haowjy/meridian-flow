#!/bin/bash
# Docker Testing Script
# Builds and tests backend Docker image using .env.test configuration
# Usage: ./test-docker.sh

set -e  # Exit on error

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Docker Testing Script ===${NC}\n"

# Check if .env.test exists
if [ ! -f ".env.test" ]; then
    echo -e "${YELLOW}Warning: .env.test not found${NC}"
    echo -e "Create it from template:"
    echo -e "  ${GREEN}cp .env.test.example .env.test${NC}"
    echo -e "  ${GREEN}nano .env.test${NC}  # Edit with your Supabase credentials"
    echo ""

    read -p "Create .env.test now? (y/n): " create_env
    if [ "$create_env" = "y" ]; then
        cp .env.test.example .env.test
        echo -e "${GREEN}Created .env.test from template${NC}"
        echo -e "${YELLOW}Please edit .env.test with your Supabase credentials, then run this script again.${NC}"
        exit 0
    else
        echo -e "${RED}Cannot proceed without .env.test${NC}"
        exit 1
    fi
fi

# Verify .env.test has production URLs (not localhost)
if grep -q "127.0.0.1" .env.test || grep -q "localhost" .env.test; then
    echo -e "${RED}Error: .env.test contains localhost URLs${NC}"
    echo -e "Docker containers cannot reach localhost on your host machine."
    echo -e "Please update .env.test with production Supabase URLs:"
    echo -e "  SUPABASE_URL=https://your-project.supabase.co"
    echo -e "  SUPABASE_DB_URL=postgresql://...@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
    exit 1
fi

echo -e "${GREEN}✓ Found .env.test${NC}\n"

# Build Docker image
echo -e "${BLUE}=== Building Docker Image ===${NC}"
echo "This may take a few minutes..."
echo ""

docker build --no-cache -t meridian-backend .

echo -e "\n${GREEN}✓ Build successful${NC}\n"

# Run container
echo -e "${BLUE}=== Starting Container ===${NC}"

CONTAINER_NAME="meridian-test-$$"  # Unique name with PID

docker run -d \
    --name "$CONTAINER_NAME" \
    -p 8080:8080 \
    --env-file .env.test \
    meridian-backend

echo -e "${GREEN}✓ Container started: $CONTAINER_NAME${NC}\n"

# Wait for server to start
echo "Waiting for server to start..."
sleep 5

# Test health endpoint
echo -e "\n${BLUE}=== Testing Health Endpoint ===${NC}"

HEALTH_RESPONSE=$(curl -s http://localhost:8080/health || echo "failed")

if [ "$HEALTH_RESPONSE" = '{"status":"ok"}' ]; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo -e "Response: ${GREEN}$HEALTH_RESPONSE${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo -e "Response: ${RED}$HEALTH_RESPONSE${NC}"
fi

# Show container logs
echo -e "\n${BLUE}=== Container Logs (last 20 lines) ===${NC}"
docker logs "$CONTAINER_NAME" 2>&1 | tail -n 20

# Check for errors in logs
echo -e "\n${BLUE}=== Checking for Errors ===${NC}"
ERROR_COUNT=$(docker logs "$CONTAINER_NAME" 2>&1 | grep -i error | wc -l | tr -d ' ')

if [ "$ERROR_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}Found $ERROR_COUNT error(s) in logs:${NC}"
    docker logs "$CONTAINER_NAME" 2>&1 | grep -i error
else
    echo -e "${GREEN}✓ No errors found${NC}"
fi

# Cleanup
echo -e "\n${BLUE}=== Cleanup ===${NC}"
read -p "Stop and remove container? (y/n): " cleanup

if [ "$cleanup" = "y" ]; then
    docker stop "$CONTAINER_NAME" > /dev/null
    docker rm "$CONTAINER_NAME" > /dev/null
    echo -e "${GREEN}✓ Container stopped and removed${NC}"
else
    echo -e "${YELLOW}Container still running: $CONTAINER_NAME${NC}"
    echo -e "To stop manually:"
    echo -e "  docker stop $CONTAINER_NAME"
    echo -e "  docker rm $CONTAINER_NAME"
    echo ""
    echo -e "To view logs:"
    echo -e "  docker logs -f $CONTAINER_NAME"
fi

# Summary
echo -e "\n${GREEN}=== Test Summary ===${NC}"
if [ "$HEALTH_RESPONSE" = '{"status":"ok"}' ] && [ "$ERROR_COUNT" -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo -e "Your Docker image is ready for deployment to Railway."
else
    echo -e "${YELLOW}⚠ Tests completed with issues${NC}"
    echo -e "Review the logs above for details."
fi

echo ""
