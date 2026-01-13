#!/usr/bin/env python3
"""
Demo script to show exactly what AWS Textract returns
This will help understand the structure of Textract's response
"""

import boto3
import json
from pathlib import Path
from parse_momo_tracker import extract_specific_pages_as_pdf

def demo_textract():
    """Show the actual structure of Textract's response"""

    # Use Momo Tracker as example (page 4 has a simple table)
    pdf_path = Path.home() / 'Desktop' / 'hedgeye' / 'Hedgeye - MOMO Tracker _ AAPL_TSLA=BEARISH, Bag7 ↓, 72% Stocks_9 of 11 Sectors ↑.pdf'

    print("="*70)
    print("AWS TEXTRACT DEMO - Understanding the Response Structure")
    print("="*70)

    # Extract page 4 as PDF
    print("\n1. Extracting page 4 from Momo Tracker PDF...")
    pdf_subset = extract_specific_pages_as_pdf(pdf_path, [4])

    # Call Textract
    print("2. Calling AWS Textract API...\n")
    textract = boto3.client('textract', region_name='us-west-1')
    response = textract.analyze_document(
        Document={'Bytes': pdf_subset},
        FeatureTypes=['TABLES']
    )

    # Show response structure
    print("="*70)
    print("TEXTRACT RESPONSE STRUCTURE")
    print("="*70)

    blocks = response['Blocks']
    print(f"\nTotal blocks returned: {len(blocks)}")

    # Count block types
    block_types = {}
    for block in blocks:
        block_type = block['BlockType']
        block_types[block_type] = block_types.get(block_type, 0) + 1

    print("\nBlock types breakdown:")
    for block_type, count in block_types.items():
        print(f"  • {block_type}: {count}")

    # Show example of each block type
    print("\n" + "="*70)
    print("EXAMPLE BLOCKS")
    print("="*70)

    # PAGE block
    page_block = next(b for b in blocks if b['BlockType'] == 'PAGE')
    print("\n1. PAGE BLOCK (top-level container):")
    print(f"   ID: {page_block['Id']}")
    print(f"   Page: {page_block.get('Page', 1)}")

    # TABLE block
    table_block = next(b for b in blocks if b['BlockType'] == 'TABLE')
    print("\n2. TABLE BLOCK (represents entire table structure):")
    print(f"   ID: {table_block['Id']}")
    print(f"   Confidence: {table_block.get('Confidence', 0):.1f}%")
    if 'Relationships' in table_block:
        child_count = len(table_block['Relationships'][0]['Ids'])
        print(f"   Child cells: {child_count}")

    # CELL block
    cell_block = next(b for b in blocks if b['BlockType'] == 'CELL')
    print("\n3. CELL BLOCK (one table cell):")
    print(f"   ID: {cell_block['Id']}")
    print(f"   Row: {cell_block['RowIndex']}, Column: {cell_block['ColumnIndex']}")
    print(f"   Confidence: {cell_block.get('Confidence', 0):.1f}%")
    if 'Relationships' in cell_block:
        word_ids = cell_block['Relationships'][0]['Ids']
        print(f"   Contains {len(word_ids)} word(s)")

    # WORD block
    word_block = next(b for b in blocks if b['BlockType'] == 'WORD')
    print("\n4. WORD BLOCK (individual word/text):")
    print(f"   ID: {word_block['Id']}")
    print(f"   Text: '{word_block['Text']}'")
    print(f"   Confidence: {word_block.get('Confidence', 0):.1f}%")
    print(f"   Bounding box: {word_block['Geometry']['BoundingBox']}")

    # LINE block
    line_blocks = [b for b in blocks if b['BlockType'] == 'LINE']
    if line_blocks:
        line_block = line_blocks[0]
        print("\n5. LINE BLOCK (text line grouping words):")
        print(f"   ID: {line_block['Id']}")
        print(f"   Text: '{line_block['Text']}'")
        print(f"   Confidence: {line_block.get('Confidence', 0):.1f}%")

    # Show how table is structured
    print("\n" + "="*70)
    print("HOW TEXTRACT STRUCTURES A TABLE")
    print("="*70)

    print("\nHierarchy:")
    print("  PAGE")
    print("   └─ TABLE (entire table)")
    print("       ├─ CELL (row=1, col=1) → contains WORD blocks")
    print("       ├─ CELL (row=1, col=2) → contains WORD blocks")
    print("       ├─ CELL (row=2, col=1) → contains WORD blocks")
    print("       └─ ... etc")

    # Show first row of table
    print("\n" + "="*70)
    print("EXAMPLE: FIRST ROW OF TABLE")
    print("="*70)

    # Get all cells from row 1
    row1_cells = [b for b in blocks if b['BlockType'] == 'CELL' and b.get('RowIndex') == 1]
    row1_cells.sort(key=lambda c: c['ColumnIndex'])

    print(f"\nRow 1 has {len(row1_cells)} columns:")
    for cell in row1_cells[:6]:  # Show first 6 columns
        col = cell['ColumnIndex']

        # Get text from this cell
        cell_text = ''
        if 'Relationships' in cell:
            for rel in cell['Relationships']:
                if rel['Type'] == 'CHILD':
                    for word_id in rel['Ids']:
                        word_block = next((b for b in blocks if b['Id'] == word_id), None)
                        if word_block and word_block['BlockType'] == 'WORD':
                            cell_text += word_block['Text'] + ' '

        print(f"  Column {col}: '{cell_text.strip()}'")

    print("\n" + "="*70)
    print("KEY INSIGHT")
    print("="*70)
    print("""
Textract doesn't just return a string - it returns a STRUCTURED HIERARCHY:

1. Identifies table boundaries
2. Detects rows and columns (RowIndex, ColumnIndex)
3. Extracts text from each cell with confidence scores
4. Preserves spatial relationships (bounding boxes)
5. Links relationships (TABLE → CELL → WORD)

This is why we can parse tables from images - Textract understands
the 2D structure, not just the text content!
    """)

if __name__ == '__main__':
    demo_textract()
