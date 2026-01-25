import re

page1_text = """
1-WEEK RE-RANK HISTORY & CALLOUTS
Top Movers: CPER (+14), SLX (+12), HYG (+10), LIT (+7), XLI (+5)
Bottom Movers: PINK (-13), KRE (-10), IWM (-8), XLV (-5), UFO (-5)
1-MONTH RE-RANK HISTORY & CALLOUTS
Top Movers: CPER (+13), QQQ (+11), SLX (+11), HBDC (+5), EIS (+5)
Bottom Movers: PALL (-16), XLV (-13), PINK (-13), PPLT (-5), GDX (-4)
"""

print("--- DEBUGGING WEEKLY TOP MOVERS ---")
week_top_match = re.search(r'Top Movers:(.*?)(Bottom Movers:|$)', page1_text, re.DOTALL | re.IGNORECASE)
if week_top_match:
    section_text = week_top_match.group(1)
    print(f"Captured Top Section: '{section_text.strip()}'")
    # Robust regex from fix
    items = re.findall(r'([A-Z]{2,6})\s*\(\+\s*(\d+)\)', section_text)
    print(f"Found {len(items)} items: {items}")
else:
    print("No Top Movers section found")

print("\n--- DEBUGGING WEEKLY BOTTOM MOVERS ---")
week_bottom_match = re.search(r'Bottom Movers:(.*?)(1-MONTH|$)', page1_text, re.DOTALL | re.IGNORECASE)
if week_bottom_match:
    section_text = week_bottom_match.group(1)
    print(f"Captured Bottom Section: '{section_text.strip()}'")
    # Robust regex from fix (negative handling)
    items = re.findall(r'([A-Z]{2,6})\s*\([−-]?\s*(\d+)\)', section_text)
    print(f"Found {len(items)} items: {items}")
else:
    print("No Bottom Movers section found")
