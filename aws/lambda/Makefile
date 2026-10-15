# Make splits paths on spaces, so $(dir ...)/$(abspath ...) break when the
# tested release builds under "Application Support". This Makefile is the only
# one read, so $(MAKEFILE_LIST) is its full path; the shell keeps it intact.
MAKEFILE_PATH := $(strip $(MAKEFILE_LIST))
PDF_PROCESSOR_DIR := $(shell cd "$$(dirname "$(MAKEFILE_PATH)")" && pwd)/
PDF_PROCESSOR_SOURCE_NAMES = \
	hedgeye_pdf_processor_lambda.py \
	date_utils.py \
	parse_bitcoin_tracker.py \
	parse_cftc.py \
	parse_early_look.py \
	parse_hedgeye_pdf.py \
	parse_macro_show.py \
	parse_momo_tracker.py \
	parse_portfolio_solutions.py \
	parse_signal_strength.py \
	parse_the_call.py \
	parse_volume.py \
	signal_strength_pages.py
GMAIL_INGESTOR_DIR := $(PDF_PROCESSOR_DIR)../../infra/lambdas/gmail_ingestor

build-HedgeyePdfProcessorFunction:
	python3 -m pip install \
		--disable-pip-version-check \
		--platform manylinux2014_x86_64 \
		--implementation cp \
		--python-version 3.12 \
		--abi cp312 \
		--only-binary=:all: \
		-r "$(PDF_PROCESSOR_DIR)requirements-pdf.txt" \
		-t "$(ARTIFACTS_DIR)"
	cd "$(PDF_PROCESSOR_DIR)" && cp $(PDF_PROCESSOR_SOURCE_NAMES) "$(ARTIFACTS_DIR)"
	cp "$(GMAIL_INGESTOR_DIR)/research_products.json" "$(ARTIFACTS_DIR)"
	cp "$(GMAIL_INGESTOR_DIR)/analyst_change_journal.py" "$(ARTIFACTS_DIR)"
	cp "$(GMAIL_INGESTOR_DIR)/global_quads.py" "$(ARTIFACTS_DIR)"
