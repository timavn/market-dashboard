PDF_PROCESSOR_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
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
PDF_PROCESSOR_SOURCES := $(addprefix $(PDF_PROCESSOR_DIR),$(PDF_PROCESSOR_SOURCE_NAMES))
RESEARCH_PRODUCT_REGISTRY := $(abspath $(PDF_PROCESSOR_DIR)../../infra/lambdas/gmail_ingestor/research_products.json)

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
	cp $(PDF_PROCESSOR_SOURCES) "$(ARTIFACTS_DIR)"
	cp "$(RESEARCH_PRODUCT_REGISTRY)" "$(ARTIFACTS_DIR)"

	cp "$(PDF_PROCESSOR_DIR)../../infra/lambdas/gmail_ingestor/analyst_change_journal.py" "$(ARTIFACTS_DIR)"

	cp "$(PDF_PROCESSOR_DIR)../../infra/lambdas/gmail_ingestor/global_quads.py" "$(ARTIFACTS_DIR)"
