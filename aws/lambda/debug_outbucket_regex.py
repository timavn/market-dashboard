
import re

text = """
#OUTBUCKET

The #OutBucket are the tickers Hedgeye CEO Keith McCullough has recently removed from Risk
Range™ Signals (for Macro fundamental or Signaling reasons) along with the current trend for that
ticker.

• Aerospace & Defense ETF (ITA) = BULLISH (8/22/2024)
• Simplify Healthcare ETF (PINK) = BULLISH (10/23/2025)
"""

print("Running Regex Test...")

# Original Pattern (failing)
# pattern = r'•\s+(.+?)\s+\(([A-Z]+)\)\s+-\s+(BULLISH|BEARISH|NEUTRAL)\s+\((\d{1,2}/\d{1,2}/\d{4})\)'

# New Pattern (support = or -)
pattern = r'•\s+(.+?)\s+\(([A-Z]+)\)\s+[=\-]\s+(BULLISH|BEARISH|NEUTRAL)\s+\((\d{1,2}/\d{1,2}/\d{4})\)'

outbucket = []
for match in re.finditer(pattern, text):
    name = match.group(1).strip()
    ticker = match.group(2)
    trend = match.group(3)
    date = match.group(4)
    outbucket.append(f"{ticker}: {trend} ({date})")

print(f"Matches found: {len(outbucket)}")
for item in outbucket:
    print(item)

if len(outbucket) == 2:
    print("✅ SUCCESS")
else:
    print("❌ FAILURE")
