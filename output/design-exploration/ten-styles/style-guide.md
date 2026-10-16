# Dashboard style explorations

Ten visual directions for the existing market dashboard, built around typography and numbers.

These are design previews, not a source of market data. All ten directions can be implemented with the installed React, Tailwind/CSS, Recharts, react-sparklines, and icon libraries. DM Sans and Manrope are already loaded; Georgia and Menlo are available on this Mac and can use system font fallbacks. No new UI framework is needed.

| # | Direction | What changes | Type |
|---|---|---|---|
| 01 | [Swiss Precision](#01-swiss-precision) | Bold hierarchy, white space, strict alignment | DM Sans |
| 02 | [Analyst Ledger](#02-analyst-ledger) | Quiet framing and precisely aligned numbers | DM Sans + Menlo |
| 03 | [Research Journal](#03-research-journal) | Serif headings with simple numerical tables | Georgia + DM Sans |
| 04 | [Light Terminal](#04-light-terminal) | Compact rows and a technical monospace rhythm | Menlo / system monospace |
| 05 | [Midnight Terminal](#05-midnight-terminal) | Dark surfaces with restrained numerical contrast | DM Sans + Menlo |
| 06 | [Nordic Blue](#06-nordic-blue) | Crisp blue accents and softer modern type | Manrope |
| 07 | [Quant Grid](#07-quant-grid) | Tables carry the layout; cards recede | DM Sans + system monospace |
| 08 | [Paper Cards](#08-paper-cards) | Quiet separate panels and clear numerical hierarchy | Manrope |
| 09 | [Graphite Hybrid](#09-graphite-hybrid) | Dark framing around bright data tables | DM Sans |
| 10 | [Financial Editorial](#10-financial-editorial) | Warm financial-paper tones and expressive headings | Georgia + DM Sans |

Start by comparing **02 Analyst Ledger** for everyday reading, **07 Quant Grid** for direct numerical comparisons, and **01 Swiss Precision** for a sharper typographic hierarchy. A final design can combine the typography of one with the table layout of another.

These are visual directions, not ten finished implementations. Quant Grid changes the arrangement of the volatility area; most other differences are typography, spacing, borders, and surface colors. A production pass would keep verified data and existing behavior, and check column alignment, density, and responsive layouts in the running dashboard.

## 01 Swiss Precision

Bold type, white space, and strict alignment. Useful if you want the typography to do most of the organizing.

![01 Swiss Precision](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/01-swiss-precision.png)

## 02 Analyst Ledger

A precise ledger with aligned monospace numbers. Quiet framing leaves the values prominent.

![02 Analyst Ledger](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/02-analyst-ledger.png)

## 03 Research Journal

Editorial headings with clean numerical tables. More like a research publication than a trading terminal.

![03 Research Journal](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/03-research-journal.png)

## 04 Light Terminal

Compact, technical, and almost entirely monospaced. Best if you like a consistent rhythm across labels and figures.

![04 Light Terminal](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/04-light-terminal.png)

## 05 Midnight Terminal

A dark numerical workspace with restrained contrast. Semantic green and red stay distinct from the dark framing.

![05 Midnight Terminal](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/05-midnight-terminal.png)

## 06 Nordic Blue

Crisp blue accents and a softer modern typeface. Clear structure without large filled header bands.

![06 Nordic Blue](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/06-nordic-blue.png)

## 07 Quant Grid

The densest direction, built around tables instead of cards. The volatility area puts more comparisons alongside one another.

![07 Quant Grid](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/07-quant-grid.png)

## 08 Paper Cards

Clear numerical hierarchy with quiet, separate panels. Fine borders and measured spacing define the groups.

![08 Paper Cards](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/08-paper-cards.png)

## 09 Graphite Hybrid

A dark frame around bright data tables. Stronger separation between sections while retaining a light reading surface.

![09 Graphite Hybrid](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/09-graphite-hybrid.png)

## 10 Financial Editorial

Warm financial-paper tones and expressive typography. Serif headings and large figures add more personality.

![10 Financial Editorial](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/10-financial-editorial.png)

---

Generation: built-in image_gen, using the supplied dashboard screenshot as the reference. Exact prompts and reference details are recorded in [generation-prompts.json](/Users/timsmith/Desktop/cursor/market-dashboard/output/design-exploration/ten-styles/generation-prompts.json).

