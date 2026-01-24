#!/bin/bash
#
# Hedgeye Scraper Management Script
# Simplifies installation, testing, and monitoring of the scraper LaunchAgent
#
# Usage:
#   ./manage_scraper.sh install   - Install and start LaunchAgent
#   ./manage_scraper.sh uninstall - Stop and remove LaunchAgent
#   ./manage_scraper.sh test      - Run scraper manually (test before scheduling)
#   ./manage_scraper.sh status    - Check if LaunchAgent is running
#   ./manage_scraper.sh logs      - Show recent logs
#   ./manage_scraper.sh restart   - Restart LaunchAgent

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SOURCE="${SCRIPT_DIR}/com.hedgeye.riskrange.scraper.production.plist"
PLIST_DEST="${HOME}/Library/LaunchAgents/com.hedgeye.riskrange.scraper.plist"
LABEL="com.hedgeye.riskrange.scraper"
LOG_DIR="${SCRIPT_DIR}/logs"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Check if LaunchAgent is loaded
is_loaded() {
    launchctl list | grep -q "${LABEL}"
}

# Install LaunchAgent
install() {
    info "Installing Hedgeye Scraper LaunchAgent..."

    # Create logs directory
    mkdir -p "${LOG_DIR}"
    info "Created logs directory: ${LOG_DIR}"

    # Check if already installed
    if is_loaded; then
        warn "LaunchAgent is already loaded. Uninstalling first..."
        uninstall
    fi

    # Copy plist to LaunchAgents folder
    if [[ ! -f "${PLIST_SOURCE}" ]]; then
        error "Source plist not found: ${PLIST_SOURCE}"
        exit 1
    fi

    cp "${PLIST_SOURCE}" "${PLIST_DEST}"
    info "Copied plist to: ${PLIST_DEST}"

    # Load the LaunchAgent
    launchctl load "${PLIST_DEST}"
    info "Loaded LaunchAgent: ${LABEL}"

    # Verify it's loaded
    if is_loaded; then
        info "✓ LaunchAgent installed successfully!"
        info ""
        info "Scheduled to run at 5:15 PM ET every weekday"
        info "Next run will be on the next weekday at 5:15 PM"
        info ""
        info "To test immediately, run: ./manage_scraper.sh test"
    else
        error "Failed to load LaunchAgent"
        exit 1
    fi
}

# Uninstall LaunchAgent
uninstall() {
    info "Uninstalling Hedgeye Scraper LaunchAgent..."

    if is_loaded; then
        launchctl unload "${PLIST_DEST}" 2>/dev/null || true
        info "Unloaded LaunchAgent"
    else
        warn "LaunchAgent was not loaded"
    fi

    if [[ -f "${PLIST_DEST}" ]]; then
        rm "${PLIST_DEST}"
        info "Removed plist file"
    fi

    info "✓ LaunchAgent uninstalled"
}

# Test scraper manually
test_scraper() {
    info "Running scraper manually (this may take 1-2 minutes)..."
    info "Watch for browser window to open if using Chrome profile..."
    echo ""

    "${SCRIPT_DIR}/run_hedgeye_scraper.sh"
}

# Check status
status() {
    info "Checking LaunchAgent status..."
    echo ""

    if is_loaded; then
        info "✓ LaunchAgent is loaded and scheduled"

        # Show detailed status
        launchctl list | grep "${LABEL}" || true
        echo ""

        # Show next run time (approximate)
        info "Schedule: Every weekday at 5:15 PM ET"

        # Show recent logs
        info ""
        info "Recent log files:"
        ls -lt "${LOG_DIR}" 2>/dev/null | head -5 || warn "No logs found"
    else
        warn "✗ LaunchAgent is not loaded"
        info "Run './manage_scraper.sh install' to install it"
    fi
}

# Show logs
show_logs() {
    local log_type="${1:-all}"

    echo ""
    info "=== Recent Scraper Logs ==="
    echo ""

    case "${log_type}" in
        all)
            # Show most recent scraper log
            local latest_log=$(ls -t "${LOG_DIR}"/scraper_*.log 2>/dev/null | head -1)
            if [[ -n "${latest_log}" ]]; then
                info "Latest log: ${latest_log}"
                echo ""
                tail -50 "${latest_log}"
            else
                warn "No scraper logs found"
            fi
            ;;
        error)
            # Show most recent error log
            local latest_error=$(ls -t "${LOG_DIR}"/scraper_error_*.log 2>/dev/null | head -1)
            if [[ -n "${latest_error}" ]]; then
                info "Latest error log: ${latest_error}"
                echo ""
                tail -50 "${latest_error}"
            else
                info "No errors logged"
            fi
            ;;
        launchd)
            # Show LaunchAgent system logs
            info "LaunchAgent stdout:"
            tail -20 "${LOG_DIR}/launchd_stdout.log" 2>/dev/null || warn "No stdout log"
            echo ""
            info "LaunchAgent stderr:"
            tail -20 "${LOG_DIR}/launchd_stderr.log" 2>/dev/null || warn "No stderr log"
            ;;
        *)
            error "Invalid log type: ${log_type}"
            info "Use: all, error, or launchd"
            exit 1
            ;;
    esac
}

# Restart LaunchAgent
restart() {
    info "Restarting LaunchAgent..."

    if is_loaded; then
        launchctl unload "${PLIST_DEST}"
        info "Unloaded LaunchAgent"
        sleep 1
    fi

    launchctl load "${PLIST_DEST}"
    info "Loaded LaunchAgent"

    if is_loaded; then
        info "✓ LaunchAgent restarted successfully"
    else
        error "Failed to restart LaunchAgent"
        exit 1
    fi
}

# Run scraper on demand
run_now() {
    info "Triggering LaunchAgent to run immediately..."

    if ! is_loaded; then
        error "LaunchAgent is not installed. Run './manage_scraper.sh install' first"
        exit 1
    fi

    launchctl start "${LABEL}"
    info "Job triggered. Check logs with: ./manage_scraper.sh logs"
}

# Main command dispatcher
main() {
    local command="${1:-}"

    case "${command}" in
        install)
            install
            ;;
        uninstall)
            uninstall
            ;;
        test)
            test_scraper
            ;;
        status)
            status
            ;;
        logs)
            show_logs "${2:-all}"
            ;;
        restart)
            restart
            ;;
        run|start)
            run_now
            ;;
        *)
            echo "Hedgeye Scraper Management Script"
            echo ""
            echo "Usage: $0 <command>"
            echo ""
            echo "Commands:"
            echo "  install    - Install and start LaunchAgent (runs at 5:15 PM weekdays)"
            echo "  uninstall  - Stop and remove LaunchAgent"
            echo "  test       - Run scraper manually (test before scheduling)"
            echo "  status     - Check if LaunchAgent is running"
            echo "  logs       - Show recent logs (add 'error' or 'launchd' for specific logs)"
            echo "  restart    - Restart LaunchAgent"
            echo "  run        - Trigger scraper to run immediately"
            echo ""
            echo "Examples:"
            echo "  $0 install           # Install and schedule"
            echo "  $0 test              # Test scraper manually"
            echo "  $0 logs error        # Show error logs only"
            echo "  $0 run               # Run scraper now (don't wait for 5:15 PM)"
            exit 1
            ;;
    esac
}

main "$@"
