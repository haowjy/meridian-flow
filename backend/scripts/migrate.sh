#!/bin/bash
# Interactive migration script with dry-run and custom DB URL support
#
# Usage:
#   ./scripts/migrate.sh              # Interactive mode, uses .env
#   ./scripts/migrate.sh --dry-run    # Preview SQL without executing
#   ./scripts/migrate.sh --db-url "postgres://..."  # Custom DB URL
#   ./scripts/migrate.sh up           # Direct action (skip prompts)
#   ./scripts/migrate.sh down
#   ./scripts/migrate.sh status
#   ./scripts/migrate.sh redo         # down + up (redo last migration)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DRY_RUN=false
DB_URL=""
TABLE_PREFIX_ARG=""
PREFIX_SET=false
ACTION=""
SKIP_PROMPTS=false
USE_DIRECT=false
VERBOSE=false
TARGET_VERSION=""
ENV_FILE_ARG=""
USE_GOOSE=true  # Default to goose for dev; --prod/--staging force SQL mode
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$BACKEND_DIR/migrations"

# Find goose binary
GOOSE=$(which goose 2>/dev/null || echo "$HOME/go/bin/goose")
if [ ! -x "$GOOSE" ]; then
    echo -e "${RED}Error: goose not found. Install with: go install github.com/pressly/goose/v3/cmd/goose@latest${NC}"
    exit 1
fi

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --db-url)
            DB_URL="$2"
            shift 2
            ;;
        --prefix)
            TABLE_PREFIX_ARG="$2"
            PREFIX_SET=true
            shift 2
            ;;
        --direct)
            USE_DIRECT=true
            shift
            ;;
        --env-file)
            ENV_FILE_ARG="$2"
            shift 2
            ;;
        --prod)
            ENV_FILE_ARG="$BACKEND_DIR/.env.prod"
            TABLE_PREFIX_ARG="prod_"
            PREFIX_SET=true
            USE_DIRECT=true
            shift
            ;;
        --test)
            ENV_FILE_ARG="$BACKEND_DIR/.env.test"
            TABLE_PREFIX_ARG="test_"
            PREFIX_SET=true
            USE_DIRECT=true
            shift
            ;;
        --local)
            USE_DIRECT=true
            shift
            ;;
        --goose)
            USE_GOOSE=true
            shift
            ;;
        --sql)
            USE_GOOSE=false
            shift
            ;;
        --to)
            TARGET_VERSION="$2"
            shift 2
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --yes|-y)
            SKIP_PROMPTS=true
            shift
            ;;
        up|down|status|redo|baseline)
            ACTION="$1"
            SKIP_PROMPTS=true  # Direct action skips prompts
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [options] [action]"
            echo ""
            echo "Options:"
            echo "  --dry-run        Preview SQL without executing"
            echo "  --db-url URL     Use custom database URL (instead of .env)"
            echo "  --direct         Use direct connection (port 5432) instead of pooler (6543)"
            echo "  --env-file FILE  Load from specific .env file (e.g., .env.prod)"
            echo "  --prefix PREFIX  Override table prefix (e.g., 'prod_', 'test_', '')"
            echo "  --to VERSION     Migrate to specific version (e.g., '00002')"
            echo "  --goose          Use goose for migration tracking (default for dev)"
            echo "  --sql            Use direct SQL via psql (no goose tracking)"
            echo "  --verbose, -v    Show detailed SQL and connection info"
            echo "  --yes, -y        Skip confirmation prompts"
            echo "  -h, --help       Show this help"
            echo ""
            echo "Environment shortcuts:"
            echo "  --prod           Load .env.prod, prod_ prefix, direct connection"
            echo "  --test           Load .env.test, test_ prefix, direct connection"
            echo "  --local          Use .env with direct connection"
            echo ""
            echo "Actions:"
            echo "  up              Apply all pending migrations"
            echo "  down            Rollback last migration"
            echo "  status          Show migration status"
            echo "  redo            Rollback and re-apply last migration"
            echo "  baseline        Mark all migrations as applied (for existing DBs)"
            echo ""
            echo "Examples:"
            echo "  $0                         # Interactive mode"
            echo "  $0 --dry-run up            # Preview 'up' SQL"
            echo "  $0 --prod up               # Production: apply pending migrations"
            echo "  $0 --prod baseline         # Mark existing prod DB as up-to-date"
            echo "  $0 --test status           # Test: show migration status"
            echo "  $0 --sql up                # Direct SQL mode (no tracking)"
            echo "  $0 --to 00002 up           # Migrate to specific version"
            echo "  $0 --verbose up            # Show SQL before executing"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage"
            exit 1
            ;;
    esac
done

# Determine which .env file to use (--env-file overrides default)
ENV_FILE="${ENV_FILE_ARG:-$BACKEND_DIR/.env}"

# Load .env if no custom DB URL provided
if [ -z "$DB_URL" ]; then
    if [ -f "$ENV_FILE" ]; then
        echo -e "${BLUE}Loading from: $(basename "$ENV_FILE")${NC}"
        # Source .env to get SUPABASE_DB_URL and ENVIRONMENT
        set -a
        source "$ENV_FILE"
        set +a
        DB_URL="$SUPABASE_DB_URL"
        TABLE_PREFIX="${ENVIRONMENT}_"
    else
        echo -e "${RED}Error: Env file not found: $ENV_FILE${NC}"
        exit 1
    fi
else
    # If custom URL provided, try to get TABLE_PREFIX from env file or default to empty
    if [ -f "$ENV_FILE" ]; then
        ENVIRONMENT=$(grep -E "^ENVIRONMENT=" "$ENV_FILE" | cut -d= -f2)
        TABLE_PREFIX="${ENVIRONMENT}_"
    else
        TABLE_PREFIX=""
    fi
fi

# Convert pooler port to direct port if --direct flag used
if [ "$USE_DIRECT" = true ]; then
    DB_URL=$(echo "$DB_URL" | sed 's/:6543/:5432/')
fi

if [ -z "$DB_URL" ]; then
    echo -e "${RED}Error: SUPABASE_DB_URL not set${NC}"
    exit 1
fi

# Override TABLE_PREFIX if --prefix was provided
if [ "$PREFIX_SET" = true ]; then
    TABLE_PREFIX="$TABLE_PREFIX_ARG"
fi

# Export TABLE_PREFIX for goose ENVSUB
export TABLE_PREFIX

# Compute tracking table name (prefix-aware)
# This allows multiple environments to coexist in the same database
TRACKING_TABLE="${TABLE_PREFIX}schema_migrations"

# Mask DB URL for display (hide password)
MASKED_URL=$(echo "$DB_URL" | sed -E 's/(:\/\/[^:]+:)[^@]+(@)/\1****\2/')

echo ""
echo -e "${BLUE}=== Meridian Database Migration ===${NC}"
echo -e "Database: ${YELLOW}$MASKED_URL${NC}"
echo -e "Table prefix: ${YELLOW}${TABLE_PREFIX:-<none>}${NC}"
if [ "$USE_DIRECT" = true ]; then
    echo -e "Connection: ${GREEN}direct (port 5432)${NC}"
fi
if [ "$USE_GOOSE" = true ]; then
    echo -e "Execution: ${GREEN}goose${NC} (tracking: ${TRACKING_TABLE})"
else
    echo -e "Execution: ${YELLOW}SQL${NC} (direct psql, no tracking)"
fi
if [ -n "$TARGET_VERSION" ]; then
    echo -e "Target version: ${YELLOW}$TARGET_VERSION${NC}"
fi
echo -e "Migrations: ${YELLOW}$MIGRATIONS_DIR${NC}"
if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}Mode: DRY RUN (no changes will be made)${NC}"
fi
if [ "$VERBOSE" = true ]; then
    echo -e "${YELLOW}Verbose mode: ON${NC}"
fi
echo ""

# Show current status
show_status() {
    echo -e "${BLUE}Current migration status:${NC}"
    if [ "$USE_GOOSE" = true ]; then
        # Goose writes status to stderr, redirect to stdout
        $GOOSE --table "$TRACKING_TABLE" -dir "$MIGRATIONS_DIR" postgres "$DB_URL" status 2>&1 || echo "  (no migrations applied yet)"
    else
        echo "  (SQL mode - goose tracking disabled)"
        echo "  Available migrations:"
        for file in "$MIGRATIONS_DIR"/*.sql; do
            if [ -f "$file" ]; then
                echo "    - $(basename "$file")"
            fi
        done
    fi
    echo ""
}

# Show header with current settings
show_header() {
    MASKED_URL=$(echo "$DB_URL" | sed -E 's/(:\/\/[^:]+:)[^@]+(@)/\1****\2/')
    # Recompute tracking table in case prefix changed
    TRACKING_TABLE="${TABLE_PREFIX}schema_migrations"
    echo ""
    echo -e "${BLUE}=== Meridian Database Migration ===${NC}"
    echo -e "Database: ${YELLOW}$MASKED_URL${NC}"
    echo -e "Table prefix: ${YELLOW}${TABLE_PREFIX:-<none>}${NC}"
    if [ "$USE_DIRECT" = true ]; then
        echo -e "Connection: ${GREEN}direct${NC} (port 5432)"
    else
        echo -e "Connection: ${YELLOW}pooler${NC} (port 6543)"
    fi
    if [ "$USE_GOOSE" = true ]; then
        echo -e "Execution: ${GREEN}goose${NC} (tracking: ${TRACKING_TABLE})"
    else
        echo -e "Execution: ${YELLOW}SQL${NC} (direct psql, no tracking)"
    fi
    echo -e "Migrations: ${YELLOW}$MIGRATIONS_DIR${NC}"
    echo ""
}

# Reload environment from a specific .env file
reload_env() {
    local env_file="$1"
    local prefix="$2"
    local use_goose="$3"

    if [ ! -f "$env_file" ]; then
        echo -e "${RED}Error: $env_file not found${NC}"
        return 1
    fi

    echo -e "${BLUE}Loading from: $(basename "$env_file")${NC}"
    set -a
    source "$env_file"
    set +a
    DB_URL="$SUPABASE_DB_URL"
    TABLE_PREFIX="$prefix"
    USE_GOOSE="$use_goose"

    # Always use direct connection for non-dev environments
    if [[ "$prefix" == "prod_" || "$prefix" == "staging_" ]]; then
        USE_DIRECT=true
        DB_URL=$(echo "$DB_URL" | sed 's/:6543/:5432/')
    fi

    export TABLE_PREFIX
    show_header
    show_status
}

# Interactive environment selection
select_environment() {
    echo -e "${BLUE}Select environment:${NC}"
    echo "  1) dev (.env)"
    echo "  2) test (.env.test)"
    echo "  3) prod (.env.prod)"
    echo "  b) Back"
    echo -n "Choose [1-3/b]: "
    read -r env_choice
    case $env_choice in
        1) reload_env "$BACKEND_DIR/.env" "${ENVIRONMENT:-dev}_" true ;;
        2) reload_env "$BACKEND_DIR/.env.test" "test_" true ;;
        3) reload_env "$BACKEND_DIR/.env.prod" "prod_" true ;;
        *) ;; # Keep current
    esac
}

# Toggle goose/SQL execution mode
toggle_execution_mode() {
    if [ "$USE_GOOSE" = true ]; then
        USE_GOOSE=false
        echo -e "Switched to ${YELLOW}SQL mode${NC} (direct psql, no tracking)"
    else
        USE_GOOSE=true
        echo -e "Switched to ${GREEN}goose mode${NC} (tracking: ${TRACKING_TABLE})"
    fi
    show_header
    show_status
}

# Change database URL interactively
change_database_url() {
    echo -e "${BLUE}Current: ${YELLOW}$MASKED_URL${NC}"
    echo -n "Enter new database URL (or 'b' to go back): "
    read -r new_url
    if [[ "$new_url" != "b" && -n "$new_url" ]]; then
        DB_URL="$new_url"
        # Apply direct mode if enabled
        if [ "$USE_DIRECT" = true ]; then
            DB_URL=$(echo "$DB_URL" | sed 's/:6543/:5432/')
        fi
        MASKED_URL=$(echo "$DB_URL" | sed -E 's/(:\/\/[^:]+:)[^@]+(@)/\1****\2/')
        echo -e "${GREEN}Database URL updated${NC}"
        show_header
        show_status
    fi
}

# Change table prefix interactively
change_table_prefix() {
    echo -e "${BLUE}Current prefix: ${YELLOW}${TABLE_PREFIX:-<none>}${NC}"
    echo -n "Enter new prefix (e.g., 'dev_', 'test_', or empty for none): "
    read -r new_prefix
    TABLE_PREFIX="$new_prefix"
    export TABLE_PREFIX
    # Recompute tracking table
    TRACKING_TABLE="${TABLE_PREFIX}schema_migrations"
    echo -e "${GREEN}Table prefix updated to: ${YELLOW}${TABLE_PREFIX:-<none>}${NC}"
    show_header
    show_status
}

# Toggle pooler/direct connection mode
toggle_connection_mode() {
    if [ "$USE_DIRECT" = true ]; then
        USE_DIRECT=false
        DB_URL=$(echo "$DB_URL" | sed 's/:5432/:6543/')
        echo -e "Switched to ${YELLOW}pooler${NC} (port 6543)"
    else
        USE_DIRECT=true
        DB_URL=$(echo "$DB_URL" | sed 's/:6543/:5432/')
        echo -e "Switched to ${GREEN}direct${NC} (port 5432)"
    fi
    MASKED_URL=$(echo "$DB_URL" | sed -E 's/(:\/\/[^:]+:)[^@]+(@)/\1****\2/')
    show_header
    show_status
}

# Preview SQL for a migration action
preview_sql() {
    local action=$1
    echo -e "${YELLOW}=== SQL Preview ($action) ===${NC}"

    case $action in
        up)
            # Show pending migrations content
            echo -e "${BLUE}Pending migrations:${NC}"
            for file in "$MIGRATIONS_DIR"/*.sql; do
                if [ -f "$file" ]; then
                    echo -e "\n${GREEN}--- $(basename "$file") ---${NC}"
                    # Show Up section only, with TABLE_PREFIX substituted
                    # Use sed '$d' instead of head -n -1 for macOS compatibility
                    sed -n '/-- +goose Up/,/-- +goose Down/p' "$file" | sed '$d' | sed "s/\${TABLE_PREFIX}/$TABLE_PREFIX/g"
                fi
            done
            ;;
        down)
            # Show last migration's Down section
            LAST_FILE=$(ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | tail -1)
            if [ -f "$LAST_FILE" ]; then
                echo -e "${GREEN}--- $(basename "$LAST_FILE") (DOWN) ---${NC}"
                sed -n '/-- +goose Down/,$p' "$LAST_FILE" | sed "s/\${TABLE_PREFIX}/$TABLE_PREFIX/g"
            fi
            ;;
    esac
    echo ""
}

# Execute migration
execute_migration() {
    local action=$1

    if [ "$DRY_RUN" = true ]; then
        preview_sql "$action"
        echo -e "${YELLOW}Dry run complete. No changes made.${NC}"
        return 0
    fi

    # Show SQL before executing if verbose mode
    if [ "$VERBOSE" = true ] && [ "$action" != "status" ]; then
        preview_sql "$action"
        echo ""
    fi

    # Execute with goose or direct SQL
    if [ "$USE_GOOSE" = true ]; then
        # Goose mode - uses prefix-aware tracking table
        case $action in
            up)
                if [ -n "$TARGET_VERSION" ]; then
                    echo -e "${GREEN}Applying migrations up to version $TARGET_VERSION...${NC}"
                    $GOOSE --table "$TRACKING_TABLE" -dir "$MIGRATIONS_DIR" postgres "$DB_URL" up-to "$TARGET_VERSION"
                else
                    echo -e "${GREEN}Applying pending migrations...${NC}"
                    $GOOSE --table "$TRACKING_TABLE" -dir "$MIGRATIONS_DIR" postgres "$DB_URL" up
                fi
                ;;
            down)
                if [ -n "$TARGET_VERSION" ]; then
                    echo -e "${YELLOW}Rolling back to version $TARGET_VERSION...${NC}"
                    $GOOSE --table "$TRACKING_TABLE" -dir "$MIGRATIONS_DIR" postgres "$DB_URL" down-to "$TARGET_VERSION"
                else
                    echo -e "${YELLOW}Rolling back last migration...${NC}"
                    $GOOSE --table "$TRACKING_TABLE" -dir "$MIGRATIONS_DIR" postgres "$DB_URL" down
                fi
                ;;
            status)
                show_status
                return 0
                ;;
            redo)
                echo -e "${YELLOW}Re-doing last migration (down + up)...${NC}"
                $GOOSE --table "$TRACKING_TABLE" -dir "$MIGRATIONS_DIR" postgres "$DB_URL" redo
                ;;
            baseline)
                echo -e "${GREEN}Creating baseline: marking all migrations as applied...${NC}"
                # Create tracking table if it doesn't exist
                psql "$DB_URL" -c "CREATE TABLE IF NOT EXISTS $TRACKING_TABLE (
                    id SERIAL PRIMARY KEY,
                    version_id BIGINT NOT NULL,
                    is_applied BOOLEAN NOT NULL DEFAULT true,
                    tstamp TIMESTAMP DEFAULT NOW()
                );" 2>/dev/null
                # Mark each migration as applied
                for file in "$MIGRATIONS_DIR"/*.sql; do
                    if [ -f "$file" ]; then
                        version=$(basename "$file" | cut -d'_' -f1 | sed 's/^0*//')
                        # Check if already exists
                        exists=$(psql "$DB_URL" -t -c "SELECT 1 FROM $TRACKING_TABLE WHERE version_id = $version LIMIT 1;" 2>/dev/null | tr -d ' ')
                        if [ "$exists" != "1" ]; then
                            psql "$DB_URL" -c "INSERT INTO $TRACKING_TABLE (version_id, is_applied) VALUES ($version, true);" 2>/dev/null
                            echo -e "  Marked: ${YELLOW}$(basename "$file")${NC} (version $version)"
                        else
                            echo -e "  Skipped: ${YELLOW}$(basename "$file")${NC} (already tracked)"
                        fi
                    fi
                done
                echo -e "${GREEN}Baseline complete!${NC}"
                ;;
        esac
    else
        # SQL mode - direct psql execution, no tracking
        case $action in
            up)
                echo -e "${GREEN}Applying migrations via psql (no goose tracking)...${NC}"
                for file in "$MIGRATIONS_DIR"/*.sql; do
                    if [ -f "$file" ]; then
                        echo -e "  Executing: ${YELLOW}$(basename "$file")${NC}"
                        # Extract Up section and substitute TABLE_PREFIX
                        sql=$(sed -n '/-- +goose Up/,/-- +goose Down/p' "$file" | sed '1d;$d' | sed "s/\${TABLE_PREFIX}/$TABLE_PREFIX/g")
                        # Skip goose directives
                        sql=$(echo "$sql" | grep -v "^-- +goose")
                        echo "$sql" | psql "$DB_URL"
                    fi
                done
                ;;
            down)
                LAST_FILE=$(ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | tail -1)
                if [ -f "$LAST_FILE" ]; then
                    echo -e "${YELLOW}Rolling back via psql (no goose tracking)...${NC}"
                    echo -e "  Executing: ${YELLOW}$(basename "$LAST_FILE") (DOWN)${NC}"
                    # Extract Down section and substitute TABLE_PREFIX
                    sql=$(sed -n '/-- +goose Down/,$p' "$LAST_FILE" | sed '1d' | sed "s/\${TABLE_PREFIX}/$TABLE_PREFIX/g")
                    sql=$(echo "$sql" | grep -v "^-- +goose")
                    echo "$sql" | psql "$DB_URL"
                else
                    echo -e "${RED}No migration files found${NC}"
                fi
                ;;
            status)
                show_status
                return 0
                ;;
            redo)
                echo -e "${YELLOW}Redo not supported in SQL mode${NC}"
                echo "Use: $0 --sql down && $0 --sql up"
                return 1
                ;;
        esac
    fi

    echo ""
    echo -e "${GREEN}Done!${NC}"
    show_status
}

# Confirm action
confirm_action() {
    local action=$1
    if [ "$SKIP_PROMPTS" = true ]; then
        return 0
    fi

    echo -en "Execute ${YELLOW}$action${NC}? [y/N] "
    read -r response
    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

# Main logic
show_status

if [ -n "$ACTION" ]; then
    # Direct action mode
    if confirm_action "$ACTION"; then
        execute_migration "$ACTION"
    else
        echo "Cancelled."
    fi
else
    # Interactive mode - loop until quit or action executed
    while true; do
        echo -e "${BLUE}Options:${NC}"
        echo "  e) Switch environment (dev/staging/prod)"
        echo "  d) Change database URL"
        echo "  p) Change table prefix"
        echo "  m) Toggle execution mode (goose ↔ SQL)"
        echo "  c) Toggle connection mode (pooler ↔ direct)"
        echo ""
        echo -e "${BLUE}Actions:${NC}"
        echo "  1) up       - Apply pending migrations"
        echo "  2) down     - Rollback last migration"
        echo "  3) status   - Show current status"
        echo "  4) redo     - Rollback and re-apply last migration"
        echo "  5) baseline - Mark all migrations as applied (for existing DBs)"
        echo "  6) quit     - Exit"

        if [ "$DRY_RUN" = true ]; then
            echo "  v) preview - Show SQL for 'up' migration"
        fi
        echo ""

        echo -n "Choose [e/d/p/m/c/1-6]: "
        read -r choice

        case $choice in
            e|E)
                select_environment
                continue
                ;;
            d|D)
                change_database_url
                continue
                ;;
            p|P)
                change_table_prefix
                continue
                ;;
            m|M)
                toggle_execution_mode
                continue
                ;;
            c|C)
                toggle_connection_mode
                continue
                ;;
            1|up)
                if confirm_action "up"; then
                    execute_migration "up"
                fi
                break
                ;;
            2|down)
                if confirm_action "down"; then
                    execute_migration "down"
                fi
                break
                ;;
            3|status)
                show_status
                continue
                ;;
            4|redo)
                if confirm_action "redo"; then
                    execute_migration "redo"
                fi
                break
                ;;
            5|baseline)
                if confirm_action "baseline"; then
                    execute_migration "baseline"
                fi
                break
                ;;
            6|q|quit)
                echo "Bye!"
                break
                ;;
            v|preview)
                if [ "$DRY_RUN" = true ]; then
                    preview_sql "up"
                else
                    echo "Preview only available in --dry-run mode"
                fi
                continue
                ;;
            *)
                echo "Invalid choice"
                continue
                ;;
        esac
    done
fi
