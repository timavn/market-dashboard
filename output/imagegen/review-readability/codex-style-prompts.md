# Codex-style review readability examples

Built-in ImageGen edit workflow. The supplied screenshot is the app-shell reference. These are design previews containing dated screenshot figures, not live reports.

Reference: /var/folders/s5/g23n70xn7gbd7nprlqcmtxtc0000gn/T/codex-clipboard-64389fc7-e97b-4ef6-b9fe-de002df0012c.png

## Example 1 — Sectioned lists

Use case: ui-mockup, editing a supplied screenshot.
Input image 1 is the BASE APP SHELL. Preserve its recognizable Codex-style conversation layout: a narrow pale gray history sidebar on the left, back/new-chat/close controls at top, search field, Today section, Inbox and Sources buttons at bottom, a white main conversation pane, and the Message The Analyst composer pinned at the bottom. The user explicitly rejected card dashboards and report boards. This must look like the same application in the reference screenshot with clearer message typography.
Generate ONE full app screenshot, preferably a tall high-resolution 1536 x 2048 canvas to allow large legible type. The sidebar uses about 21% of the width. The conversation is one single vertical text column with a comfortable reading width and generous padding. Show Balance Review, Portfolio Review, and Prediction Markets consecutively as three short example outputs within this single conversation pane. All three outputs must be visible above the composer, with large readable text. Do not place reports side by side. Do not make a collage of app windows.
Sidebar: retain the reference controls and labels "Search all history...", "TODAY", "Inbox", "Sources". Add simple text history entries "Balance Review", "Portfolio Review", "Prediction Markets" using quiet native sidebar styling.
Main top bar: small normal app text "Review layout preview". Below it, unobtrusive but readable metadata "Dated screenshot figures · Sep 7, 2026, 01:07 UTC". This identifies a design preview; these are NOT claims of live values.
Style: simple Codex-like markdown message text. Neutral charcoal text, white main background, light gray sidebar, a restrained muted teal accent only in existing sidebar/composer controls from the reference. Use a modern clear system sans-serif, normal width letters, not condensed. Body type about 26–28px at the requested canvas, line height 1.5. Report headings about 34px, subsection labels about 26px semibold. Strong hierarchy comes only from font weight, whitespace, and true visible bullet markers. All text left aligned, naturally spaced. Bold labels or values sparingly.
Strictly no cards, no tiles, no metric widgets, no pills, no colored callouts, no tables or grids, no graphs, no big numbered badges, no decorative illustrations, no extra marketing header, no three-column report layout. No repeated headings. No long paragraphs. No grouped numbers with slash separators. Each financial metric gets its own text line. Preserve every number exactly. Do not invent recommendations, market values, current data, price quotes, or contract names.
The bottom composer must remain visually consistent with the input image, with "Message The Analyst..." and the simple send control. Do not crowd the last report into it. If necessary, make the screenshot taller rather than shrinking the text.

VARIANT A: clear markdown headings and ordinary bulleted lists. Use clean prominent report titles, modest bold subsection labels, and black round bullet markers. Comfortable spacing between the three report outputs, minimal spacing between the lines of each list. No special graphic treatment around sections.
Render exactly this content in the main message column, as formatted text (asterisks in this prompt indicate typographic bold, not literal characters):

Balance Review
Partial · USD

Account
• Net liquidation: $170,188.01
• Available funds: $85,173.30
• Buying power: $340,693.21
• Excess liquidity: $85,204.10

Needs attention
• Borrowing balance: unavailable
• Liquidity buffer: unavailable

Portfolio Review
Exposure from the supplied snapshot

Exposure
• Long market value: $142,505.09
• Short market value: $85,592.32
• Gross exposure: $228,097.41
• Net exposure: $56,912.77
• Gross leverage: 1.340×

Evidence to add
• Holding details and research were not supplied.

Prediction Markets
Example with missing market data

Required evidence
• Contract and venue: not supplied
• Native bid and ask: unavailable
• Expiration and settlement: not supplied
• Held-contract exposure: not supplied

Use a small unobtrusive text label "Example 1 · Sectioned lists" in the main top bar next to Review layout preview, not as a graphic heading. The final result must feel like a readable native chat reply, not a redesigned dashboard.

## Example 2 — Compact outline

Use case: ui-mockup, editing a supplied screenshot.
Input image 1 is the BASE APP SHELL. Preserve its recognizable Codex-style conversation layout: a narrow pale gray history sidebar on the left, back/new-chat/close controls at top, search field, Today section, Inbox and Sources buttons at bottom, a white main conversation pane, and the Message The Analyst composer pinned at the bottom. The user explicitly rejected card dashboards and report boards. This must look like the same application in the reference screenshot with clearer message typography.
Generate ONE full app screenshot, preferably a tall high-resolution 1536 x 2048 canvas to allow large legible type. The sidebar uses about 21% of the width. The conversation is one single vertical text column with a comfortable reading width and generous padding. Show Balance Review, Portfolio Review, and Prediction Markets consecutively as three short example outputs within this single conversation pane. All three outputs must be visible above the composer, with large readable text. Do not place reports side by side. Do not make a collage of app windows.
Sidebar: retain the reference controls and labels "Search all history...", "TODAY", "Inbox", "Sources". Add simple text history entries "Balance Review", "Portfolio Review", "Prediction Markets" using quiet native sidebar styling.
Main top bar: small normal app text "Review layout preview". Below it, unobtrusive but readable metadata "Dated screenshot figures · Sep 7, 2026, 01:07 UTC". This identifies a design preview; these are NOT claims of live values.
Style: simple Codex-like markdown message text. Neutral charcoal text, white main background, light gray sidebar, a restrained muted teal accent only in existing sidebar/composer controls from the reference. Use a modern clear system sans-serif, normal width letters, not condensed. Body type about 26–28px at the requested canvas, line height 1.5. Report headings about 34px, subsection labels about 26px semibold. Strong hierarchy comes only from font weight, whitespace, and true visible bullet markers. All text left aligned, naturally spaced. Bold labels or values sparingly.
Strictly no cards, no tiles, no metric widgets, no pills, no colored callouts, no tables or grids, no graphs, no big numbered badges, no decorative illustrations, no extra marketing header, no three-column report layout. No repeated headings. No long paragraphs. No grouped numbers with slash separators. Each financial metric gets its own text line. Preserve every number exactly. Do not invent recommendations, market values, current data, price quotes, or contract names.
The bottom composer must remain visually consistent with the input image, with "Message The Analyst..." and the simple send control. Do not crowd the last report into it. If necessary, make the screenshot taller rather than shrinking the text.

VARIANT B: compact text outline with bold run-in labels and lightly indented values. Use one simple report title followed by tidy unboxed one-fact-per-line text. This option is a more compact alternative to ordinary bullet lists: metric rows are plain text, with the label bold and its value immediately following after a colon, not right-aligned in a table. Use bullets only for missing evidence. Separate the three report outputs with one quiet thin horizontal hairline and modest vertical whitespace. Every section stays in the same single reading column. No report cards.
Render exactly this content in the main message column; make each label before a colon bold and values regular:

Balance Review
Partial · USD

Net liquidation: $170,188.01
Available funds: $85,173.30
Buying power: $340,693.21
Excess liquidity: $85,204.10

Missing data
• Borrowing balance: unavailable
• Liquidity buffer: unavailable

Portfolio Review
Exposure from the supplied snapshot

Long market value: $142,505.09
Short market value: $85,592.32
Gross exposure: $228,097.41
Net exposure: $56,912.77
Gross leverage: 1.340×

Missing evidence
• Holding details and research were not supplied.

Prediction Markets
Example with missing market data

Contract and venue: not supplied
Native bid and ask: unavailable
Expiration and settlement: not supplied
Held-contract exposure: not supplied

Use a small unobtrusive text label "Example 2 · Compact outline" in the main top bar next to Review layout preview, not as a graphic heading. The final result must feel like a readable native chat reply, not a redesigned dashboard.

