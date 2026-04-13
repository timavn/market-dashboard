#!/usr/bin/env python3
"""
Deployed version of the Hedgeye volume parser for the PDF Lambda.
This file mirrors aws/lambda/parse_volume.py so the Lambda package
can include the volume snapshot extraction logic.
"""

from parse_volume import extract_volume_snapshot, upload_pdf_to_s3, save_to_dynamodb  # re-export
