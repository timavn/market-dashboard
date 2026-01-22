
import re

text = """
1/9/26, 1:34 PM
HEDGEYE
JANUARY 9, 2026
01/09/26 07:45AM EST
How to use Risk Range Signals
"""

month_names = {
    'JANUARY': 1, 'FEBRUARY': 2, 'MARCH': 3, 'APRIL': 4,
    'MAY': 5, 'JUNE': 6, 'JULY': 7, 'AUGUST': 8,
    'SEPTEMBER': 9, 'OCTOBER': 10, 'NOVEMBER': 11, 'DECEMBER': 12
}

print(f"Testing text:\n{text}\n")

found = False
for month_name, month_num in month_names.items():
    # Look for MONTH DD, YYYY with optional comma
    pattern = rf'{month_name}\s+(\d{{1,2}}),?\s+(\d{{4}})'
    match = re.search(pattern, text, re.IGNORECASE)
    if match:
        day = int(match.group(1))
        year = int(match.group(2))
        print(f"✅ MATCH FOUND: {month_name} {day}, {year}")
        found = True
        break

if not found:
    print("❌ NO MATCH FOUND")
