#!/usr/bin/env python3
"""
Deployed version of The Call parser for the Hedgeye PDF Lambda.
This file mirrors aws/lambda/parse_the_call.py so that the Lambda
package always includes the latest neutral parsing logic.
"""

from parse_the_call import extract_the_call, upload_pdf_to_s3, save_to_dynamodb  # re-export

