#!/bin/bash
# Migrate Schema for Specific Table Prefix
# Usage: ./scripts/migrate-prefix.sh [prefix]
# Example: ./scripts/migrate-prefix.sh test_
#          ./scripts/migrate-prefix.sh        (interactive mode)

set -e  # Exit on error

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# If no argument provided, show interactive menu
if [ $# -eq 0 ]; then
    echo -e "${BLUE}=== Meridian Schema Migration ===${NC}\n"
    echo "Select table prefix to migrate:"
    echo "  1) test_"
    echo "  2) prod_"
    echo "  3) custom (enter manually)"
    echo ""
    read -p "Enter choice (1-3): " choice

    case $choice in
        1)
            PREFIX="test_"
            ;;
        2)
            PREFIX="prod_"
            ;;
        3)
            read -p "Enter custom prefix: " PREFIX
            ;;
        *)
            echo -e "${RED}Error: Invalid choice${NC}"
            exit 1
            ;;
    esac
elif [ $# -eq 1 ]; then
    PREFIX=$1
else
    echo -e "${RED}Error: Too many arguments${NC}"
    echo "Usage: $0 [prefix]"
    echo "Example: $0 test_"
    echo "         $0        (interactive mode)"
    exit 1
fi

# Validate prefix format (should end with _)
if [[ ! "$PREFIX" =~ _$ ]]; then
    echo -e "${YELLOW}Warning: Prefix should end with underscore${NC}"
    read -p "Add underscore? (y/n): " add_underscore
    if [ "$add_underscore" = "y" ]; then
        PREFIX="${PREFIX}_"
    fi
fi

echo -e "${BLUE}=== Migrating Schema for Prefix: ${YELLOW}${PREFIX}${NC}${BLUE} ===${NC}\n"

# Prompt for Supabase DB URL
echo -e "${YELLOW}Enter Supabase DB URL:${NC}"
echo -e "${BLUE}Format: postgresql://postgres.[PROJECT-REF]:[PASSWORD]@[HOST]:6543/postgres${NC}"
read -p "> " SUPABASE_DB_URL

if [ -z "$SUPABASE_DB_URL" ]; then
    echo -e "${RED}Error: DB URL cannot be empty${NC}"
    exit 1
fi

# Validate URL format (basic check)
if [[ ! "$SUPABASE_DB_URL" =~ ^postgresql:// ]]; then
    echo -e "${RED}Error: Invalid PostgreSQL URL format${NC}"
    echo "Expected format: postgresql://..."
    exit 1
fi

# Extract and show sanitized URL (hide password)
SANITIZED_URL=$(echo "$SUPABASE_DB_URL" | sed -E 's/:([^:@]+)@/:****@/')
echo -e "${GREEN}✓ Using connection:${NC} $SANITIZED_URL\n"

# Check if tables already exist
echo "Checking if tables already exist..."
TABLE_CHECK=$(psql "$SUPABASE_DB_URL" -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${PREFIX}projects');" 2>/dev/null || echo "f")

if [ "$TABLE_CHECK" = " t" ]; then
    echo -e "${YELLOW}Warning: Tables with prefix '${PREFIX}' already exist${NC}"
    read -p "Drop existing tables first? (y/n): " drop_tables

    if [ "$drop_tables" = "y" ]; then
        echo "Dropping existing tables..."

        # Drop in reverse dependency order
        psql "$SUPABASE_DB_URL" <<EOF
DROP TABLE IF EXISTS ${PREFIX}user_preferences CASCADE;
DROP TABLE IF EXISTS ${PREFIX}turn_blocks CASCADE;
DROP TABLE IF EXISTS ${PREFIX}turns CASCADE;
DROP TABLE IF EXISTS ${PREFIX}chats CASCADE;
DROP TABLE IF EXISTS ${PREFIX}documents CASCADE;
DROP TABLE IF EXISTS ${PREFIX}folders CASCADE;
DROP TABLE IF EXISTS ${PREFIX}projects CASCADE;
DROP FUNCTION IF EXISTS ${PREFIX}update_updated_at_column() CASCADE;
EOF

        echo -e "${GREEN}✓ Tables dropped${NC}"
    fi
fi

# Run migration with prefix substitution
echo -e "\n${BLUE}Running migration...${NC}"

# Path to migration file (try both locations)
if [ -f "backend/migrations/00001_initial_schema.sql" ]; then
    MIGRATION_FILE="backend/migrations/00001_initial_schema.sql"
elif [ -f "migrations/00001_initial_schema.sql" ]; then
    MIGRATION_FILE="migrations/00001_initial_schema.sql"
else
    echo -e "${RED}Error: Migration file not found${NC}"
    echo "Expected: backend/migrations/00001_initial_schema.sql"
    exit 1
fi

# Extract +goose Up section only (ignore +goose Down for applying migration)
# Replace ${TABLE_PREFIX} with actual prefix
# Run against database
awk '/\+goose Up/,/\+goose Down/ {if !/\+goose Down/ print}' "$MIGRATION_FILE" | \
    sed "s/\${TABLE_PREFIX}/$PREFIX/g" | \
    sed "s/-- +goose ENVSUB ON//g" | \
    psql "$SUPABASE_DB_URL" 2>&1 | \
    grep -v "^$" | \
    while read line; do
        if [[ "$line" =~ ERROR ]]; then
            echo -e "${RED}$line${NC}"
        else
            echo "$line"
        fi
    done

# Check if migration succeeded
if [ ${PIPESTATUS[3]} -eq 0 ]; then
    echo -e "\n${GREEN}=== Migration Complete ===${NC}"
    echo -e "Created tables with prefix: ${GREEN}${PREFIX}${NC}"

    # Show created tables
    echo -e "\n${BLUE}Tables created:${NC}"
    psql "$SUPABASE_DB_URL" -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '${PREFIX}%' ORDER BY table_name;"

    echo -e "\n${YELLOW}Note: This migration is NOT tracked by goose${NC}"
    echo -e "Goose only tracks '${PREFIX}' prefix (typically 'dev_')"
    echo -e "Manage test/prod prefixes manually or use separate databases\n"
else
    echo -e "\n${RED}=== Migration Failed ===${NC}"
    echo "Check errors above for details"
    exit 1
fi
