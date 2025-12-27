#!/bin/bash
#
# Hedgeye Risk Range Scraper - Production Wrapper Script
# Handles error cases, retries, and notifications
#
# Author: Auto-generated
# Date: 2025-12-22

set -euo pipefail  # Exit on errors, undefined vars, pipe failures

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/logs"
SCRAPER_SCRIPT="${SCRIPT_DIR}/hedgeye_local_scraper.py"
PYTHON="/usr/bin/python3"
MAX_RETRIES=2
RETRY_DELAY=300  # 5 minutes

# Create logs directory if it doesn't exist
mkdir -p "${LOG_DIR}"

# Log files with date
LOG_DATE=$(date +%Y-%m-%d)
LOG_FILE="${LOG_DIR}/scraper_${LOG_DATE}.log"
ERROR_FILE="${LOG_DIR}/scraper_error_${LOG_DATE}.log"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "${ERROR_FILE}" >&2
}

# Send desktop notification (macOS)
notify() {
    local title="$1"
    local message="$2"
    osascript -e "display notification \"${message}\" with title \"${title}\"" 2>/dev/null || true
}

# Main scraping function
run_scraper() {
    local attempt=$1

    log "======================================================================"
    log "Hedgeye Risk Range Scraper - Attempt ${attempt}/${MAX_RETRIES}"
    log "======================================================================"

    # Check if Python script exists
    if [[ ! -f "${SCRAPER_SCRIPT}" ]]; then
        log_error "Scraper script not found: ${SCRAPER_SCRIPT}"
        return 1
    fi

    # Check if cookies file exists (session validation)
    local cookies_file="${SCRIPT_DIR}/hedgeye_cookies.json"
    if [[ -f "${cookies_file}" ]]; then
        local cookie_age=$(( $(date +%s) - $(stat -f%m "${cookies_file}") ))
        local cookie_age_days=$(( cookie_age / 86400 ))
        log "Cookie file age: ${cookie_age_days} days"

        if [[ ${cookie_age_days} -gt 7 ]]; then
            log "WARNING: Cookie file is ${cookie_age_days} days old - may need refresh"
        fi
    else
        log "WARNING: No cookie file found - will attempt login"
    fi

    # Run the scraper
    log "Starting scraper with Chrome profile..."
    if "${PYTHON}" "${SCRAPER_SCRIPT}" --scrape --chrome 2>&1 | tee -a "${LOG_FILE}"; then
        log "✓ Scraping completed successfully"

        # Verify output file was created
        local output_file="${SCRIPT_DIR}/hedgeye_risk_ranges.json"
        if [[ -f "${output_file}" ]]; then
            local security_count=$(grep -o '"lrr"' "${output_file}" | wc -l | tr -d ' ')
            log "✓ Output file created with ${security_count} securities"
            notify "Hedgeye Scraper" "Successfully scraped ${security_count} securities"
            return 0
        else
            log_error "Output file not created: ${output_file}"
            return 1
        fi
    else
        local exit_code=$?
        log_error "Scraper failed with exit code: ${exit_code}"
        return 1
    fi
}

# Main execution
main() {
    log "Starting Hedgeye scraper job"
    log "Working directory: ${SCRIPT_DIR}"
    log "Python: ${PYTHON}"

    # Verify Python is available
    if ! command -v "${PYTHON}" &> /dev/null; then
        log_error "Python not found at: ${PYTHON}"
        notify "Hedgeye Scraper Error" "Python interpreter not found"
        exit 1
    fi

    # Verify Python version (need 3.7+)
    local python_version=$(${PYTHON} --version 2>&1 | awk '{print $2}')
    log "Python version: ${python_version}"

    # Attempt scraping with retries
    local attempt=1
    while [[ ${attempt} -le ${MAX_RETRIES} ]]; do
        if run_scraper ${attempt}; then
            log "======================================================================"
            log "Job completed successfully on attempt ${attempt}"
            log "======================================================================"
            exit 0
        else
            log "Attempt ${attempt} failed"

            if [[ ${attempt} -lt ${MAX_RETRIES} ]]; then
                log "Waiting ${RETRY_DELAY} seconds before retry..."
                sleep ${RETRY_DELAY}
                attempt=$((attempt + 1))
            else
                log_error "All ${MAX_RETRIES} attempts failed"
                notify "Hedgeye Scraper Failed" "All ${MAX_RETRIES} scraping attempts failed. Check logs."

                # Check if it's a session issue
                if grep -q "sign_in\|login\|expired" "${LOG_FILE}" 2>/dev/null; then
                    log_error "Session appears to be expired - manual login required"
                    notify "Hedgeye Login Required" "Please ask Claude Desktop to login and extract cookies"
                fi

                exit 1
            fi
        fi
    done
}

# Run main function
main "$@"
