# Expanded probability matrix concepts

Built-in image_gen tool. User-provided selected B screenshot is the image reference. All numeric results illustrative, not computed backtests.

## Design 1

Use case: ui-mockup / precise-object-edit.
Reference image: user-selected analytical Bitcoin Research table. Preserve its compact spreadsheet styling and light-mode appearance while expanding it into a large research matrix.

User requirements:
1. DELETE the ENTIRE top banner containing "B · Bullish and bearish", "BITCOIN RESEARCH", and its title bar. Do not recreate any title row, brand heading, design name, or marketing header. The VERY TOP of the window must immediately be a slim row of research selectors.
2. Replace the hardcoded "USD rule: move … | Edit" sentence with a REAL-LOOKING CLOSED DROPDOWN, just like other controls. Label "USD rule"; selected value "30-session levels · ≤−0.50 · ≥10 bp · prior day", a visible downward chevron at right. It should read unambiguously as editable. This preset controls the rule, while USD direction is a matrix axis. NO static rule-only sentence or Edit link.
3. The matrix fills essentially the whole window. Bigger means many combinations visible together, not larger typography. Preserve normal-size statistical text, clear groups, tight grid and analytical feel. A heatmap should make the highest observed historical close frequencies easy to scan.
4. Keep the data clearly identified as design examples. Footer at bottom right MUST say "DESIGN CONCEPT · EXAMPLE VALUES". All percentages, sample counts and intervals in this concept are illustrative. No live or verified labels, no trading orders, bet buttons, recommendation or sizing controls.

Canvas landscape about 2048x1280, crisp high resolution. One flat centered rectangular research window occupies 97% of canvas; only a tiny margin of blurred dashboard behind it. No device frame. No blank whitespace or large cards. Hairline outer border. Square corners everywhere.
Match main dashboard/table reference style: DM Sans or similar, normal 400 body weights for all values and row labels, tabular numeric alignment; small bold column headers only, light gray #e9ecef section bands and #f5f6f7 column bands; white background; thin continuous gray #85909c grid with dark #526171 separators between groups. Dark gray text. Compact cells. Percentage in first small regular-weight line, sample in a second smaller normal-weight line. Sample format is HOURS / DISTINCT DAYS, e.g. "200 / 40"; explain this exactly once in a tiny legend. Two lines should still form dense table rows, about 34–40 pixels high at a 2x screenshot scale. Body percentages must NOT become large or bold. NO cards, pill badges, rounded buttons, decorative charts, gradients outside heatmap cells, glossy effects, floating panels or big summary statistic.
Top narrow selector row(s): "Study [5Y ▾]", "Interval [Hourly ▾]", "Sampling [Every qualifying hour ▾]", "USD rule [30-session levels · ≤−0.50 · ≥10 bp · prior day ▾]". Use one or two very compact control rows as needed. Close X may appear at far right on the same row, no separate header. Include a compact "Minimum sample [30 hours / 10 days ▾]" control. Other selector(s) specified below.
Heatmap is restrained cell background tint, never saturated to unreadability. Text always readable charcoal. Use thin charcoal outline for selected combination. Below sample minimum, render percent with †, gray/unfilled, never highlight as a highest-probability result.
Below matrix exactly ONE normal-height ruled detail strip for selected cell with "Baseline", "Δ pp", "Hours / days", "95% interval". No summary cards. Bottom slim footer disclosure controls "Coverage", "Year by year", "Volume & Quad", "Method & sources", "Export", plus design-example label. Tiny legend "Cells: close % · hours / days. † Below sample minimum." Include only useful text and no filler such as select a combination.
The term is "close frequency", not win rate or profit probability. Don't add invented current market state.

DESIGN 1: COMPREHENSIVE MATRIX. No design title in image.
Additional selector "Outcome [Up closes % ▾]". All percentages in this image mean the same thing, BTC closing UP; the outcome selector can switch to Down closes. Do not infer a trading direction from regime.
One giant 15-row × 12-data-column heatmap matrix. Two left stub columns "Regime" and "Entry zone". Three five-row groups Bullish, Bearish, Neutral; within every group the entry zones Below range, Bottom third, Middle third, Top third, Above range. The regime names are merged vertical cells spanning five rows, rendered normal weight; Bullish text green, Bearish red, Neutral gray.
Columns have THREE major groups: "USD OFF", "USD DOWN", "USD UP". Within EACH are four volatility columns: "All", "Investable", "Chop", "Uninvestable". No column omission. These volatility labels normal size, header bold. Use a slightly darker vertical separator between USD groups. Matrix top-left corner header may read "UP CLOSES %" in small bold text.
Exact illustrative percentages in row order, all suffixed %. There are exactly twelve values in each row, USD Off four first, then Down four, then Up four:
Bullish | Below range | 55.0 | 58.0 | 53.0 | 51.0 | 60.0 | 64.0 | 57.0 | 54.0 | 48.0 | 52.0 | 47.0 | 45.0
Bullish | Bottom third | 58.0 | 61.0 | 56.0 | 54.0 | 63.0 | 66.0 | 61.0 | 59.0 | 52.0 | 55.0 | 50.0 | 46.7
Bullish | Middle third | 53.0 | 56.0 | 51.0 | 49.0 | 57.0 | 61.0 | 54.0 | 52.0 | 49.0 | 51.0 | 48.0 | 45.0
Bullish | Top third | 49.0 | 52.0 | 47.0 | 45.0 | 52.0 | 56.0 | 50.0 | 47.0 | 45.0 | 48.0 | 44.0 | 41.0
Bullish | Above range | 47.0 | 50.0 | 45.0 | 43.0 | 50.0 | 53.0 | 47.0 | 44.0 | 43.0 | 46.0 | 42.0 | 39.0
Bearish | Below range | 53.0 | 55.0 | 52.0 | 49.0 | 58.0 | 61.0 | 56.0 | 54.0 | 49.0 | 51.0 | 47.0 | 44.0
Bearish | Bottom third | 52.0 | 54.0 | 50.0 | 48.0 | 57.0 | 60.0 | 55.0 | 51.0 | 47.0 | 50.0 | 45.0 | 42.0
Bearish | Middle third | 50.0 | 52.0 | 49.0 | 47.0 | 54.0 | 57.0 | 52.0 | 49.0 | 44.0 | 47.0 | 42.0 | 39.0
Bearish | Top third | 48.0 | 44.0 | 50.0 | 52.0 | 52.5 | 50.0 | 53.1 | 56.2 | 40.0 | 35.0 | 41.7 | 46.7
Bearish | Above range | 45.0 | 43.0 | 46.0 | 49.0 | 49.0 | 46.0 | 51.0 | 53.0 | 38.0 | 36.0 | 40.0 | 43.0
Neutral | Below range | 51.0 | 53.0 | 50.0 | 48.0 | 54.0 | 57.0 | 52.0 | 50.0 | 49.0 | 51.0 | 47.0 | 46.0
Neutral | Bottom third | 52.0 | 54.0 | 51.0 | 49.0 | 55.0 | 58.0 | 53.0 | 51.0 | 50.0 | 52.0 | 48.0 | 47.0
Neutral | Middle third | 50.0 | 51.0 | 49.0 | 48.0 | 52.0 | 54.0 | 50.0 | 49.0 | 48.0 | 49.0 | 47.0 | 46.0
Neutral | Top third | 48.0 | 50.0 | 47.0 | 46.0 | 50.0 | 52.0 | 49.0 | 47.0 | 46.0 | 48.0 | 45.0 | 44.0
Neutral | Above range | 46.0 | 48.0 | 45.0 | 44.0 | 48.0 | 50.0 | 47.0 | 45.0 | 44.0 | 46.0 | 43.0 | 42.0
Below each percentage put small sample counts in hours / days. For Bullish Bottom third use this exact 12-cell sample vector:
1000 / 180 | 500 / 100 | 250 / 60 | 250 / 65 | 400 / 85 | 200 / 40 | 100 / 24 | 100 / 26 | 300 / 70 | 160 / 35 | 80 / 20 | 60 / 18
For other rows, show believable illustrative sample counts in the same compact format. Keep counts coherent within each USD group: state counts sum to its All hours, no state count exceeds All, day count never exceeds hours. Typical filtered samples 60–300 hours / 15–60 days, unfiltered 500–1500 hours / 100–250 days. Most cells meet the minimum.
Override only Neutral Above range USD Down Uninvestable to "75.0%†" with "8 / 2", unfilled gray and NOT highlighted. This demonstrates that the largest small-sample number isn't strongest evidence. Do not color it. Adjust that group's All count consistently if necessary.
Heatmap scale for selected UP outcome: values below50 faint red,50 white,55 very pale green,60 pale green,65+ medium muted green. Use continuous subtle variation with exact printed values; no huge blocks with heavy saturated backgrounds. Small inline legend "Up closes: 40% [pale red] 50% [white] 60% [pale green] 66% [muted green]". Selected Bullish/Bottom third × USD Down/Investable cell66.0% is thin charcoal outlined. It is the strongest qualified up-close example.
Below matrix, one compact detail strip: "Bullish · Bottom third | USD Down · Investable | Up 66.0% | Baseline 58.0% | Δ +8.0 pp | 200 hours / 40 days | 95% interval 59.2–72.2%".
Keep entire 180-cell matrix crisp, uniform dense and legible. The matrix itself dominates the screen. Do not add any headline over the top controls.

## Design 2

Use case: ui-mockup / precise-object-edit.
Reference image: user-selected analytical Bitcoin Research table. Preserve its compact spreadsheet styling and light-mode appearance while expanding it into a large research matrix.

User requirements:
1. DELETE the ENTIRE top banner containing "B · Bullish and bearish", "BITCOIN RESEARCH", and its title bar. Do not recreate any title row, brand heading, design name, or marketing header. The VERY TOP of the window must immediately be a slim row of research selectors.
2. Replace the hardcoded "USD rule: move … | Edit" sentence with a REAL-LOOKING CLOSED DROPDOWN, just like other controls. Label "USD rule"; selected value "30-session levels · ≤−0.50 · ≥10 bp · prior day", a visible downward chevron at right. It should read unambiguously as editable. This preset controls the rule, while USD direction is a matrix axis. NO static rule-only sentence or Edit link.
3. The matrix fills essentially the whole window. Bigger means many combinations visible together, not larger typography. Preserve normal-size statistical text, clear groups, tight grid and analytical feel. A heatmap should make the highest observed historical close frequencies easy to scan.
4. Keep the data clearly identified as design examples. Footer at bottom right MUST say "DESIGN CONCEPT · EXAMPLE VALUES". All percentages, sample counts and intervals in this concept are illustrative. No live or verified labels, no trading orders, bet buttons, recommendation or sizing controls.

Canvas landscape about 2048x1280, crisp high resolution. One flat centered rectangular research window occupies 97% of canvas; only a tiny margin of blurred dashboard behind it. No device frame. No blank whitespace or large cards. Hairline outer border. Square corners everywhere.
Match main dashboard/table reference style: DM Sans or similar, normal 400 body weights for all values and row labels, tabular numeric alignment; small bold column headers only, light gray #e9ecef section bands and #f5f6f7 column bands; white background; thin continuous gray #85909c grid with dark #526171 separators between groups. Dark gray text. Compact cells. Percentage in first small regular-weight line, sample in a second smaller normal-weight line. Sample format is HOURS / DISTINCT DAYS, e.g. "200 / 40"; explain this exactly once in a tiny legend. Two lines should still form dense table rows, about 34–40 pixels high at a 2x screenshot scale. Body percentages must NOT become large or bold. NO cards, pill badges, rounded buttons, decorative charts, gradients outside heatmap cells, glossy effects, floating panels or big summary statistic.
Top narrow selector row(s): "Study [5Y ▾]", "Interval [Hourly ▾]", "Sampling [Every qualifying hour ▾]", "USD rule [30-session levels · ≤−0.50 · ≥10 bp · prior day ▾]". Use one or two very compact control rows as needed. Close X may appear at far right on the same row, no separate header. Include a compact "Minimum sample [30 hours / 10 days ▾]" control. Other selector(s) specified below.
Heatmap is restrained cell background tint, never saturated to unreadability. Text always readable charcoal. Use thin charcoal outline for selected combination. Below sample minimum, render percent with †, gray/unfilled, never highlight as a highest-probability result.
Below matrix exactly ONE normal-height ruled detail strip for selected cell with "Baseline", "Δ pp", "Hours / days", "95% interval". No summary cards. Bottom slim footer disclosure controls "Coverage", "Year by year", "Volume & Quad", "Method & sources", "Export", plus design-example label. Tiny legend "Cells: close % · hours / days. † Below sample minimum." Include only useful text and no filler such as select a combination.
The term is "close frequency", not win rate or profit probability. Don't add invented current market state.

DESIGN 2: ONE CONTINUOUS TWO-DIRECTION MATRIX. No design title in image.
Additional control "Entries [All zones ▾]". Preserve the original two hypotheses explicitly. NO giant title saying Bitcoin Research or Bullish and bearish.
One giant 15-row ×8-data-column matrix. LEFT stub columns "Entry zone" and "USD". Five entry-zone groups each span three rows: Below range, Bottom third, Middle third, Top third, Above range. Within each, USD rows Off, Down, Up.
The eight data columns have TWO major bands INSIDE THE TABLE HEADER, not a separate page banner:
"BULLISH · UP CLOSES %" over four volatility columns All, Investable, Chop, Uninvestable;
"BEARISH · DOWN CLOSES %" over four volatility columns All, Investable, Chop, Uninvestable.
A darker central rule divides these bands but both are one shared table, no cards and no gaps. This is an expanded version of the chosen reference, covering all five entry zones at once.
Values below are exact illustrative frequencies, left four bullish UP, right four bearish DOWN. There are eight percentages per row:
Below range | Off | 55.0 | 58.0 | 53.0 | 51.0 | 47.0 | 45.0 | 48.0 | 51.0
Below range | Down | 60.0 | 64.0 | 57.0 | 54.0 | 42.0 | 39.0 | 44.0 | 46.0
Below range | Up | 48.0 | 52.0 | 47.0 | 45.0 | 51.0 | 49.0 | 53.0 | 56.0
Bottom third | Off | 58.0 | 61.0 | 56.0 | 54.0 | 48.0 | 46.0 | 50.0 | 52.0
Bottom third | Down | 63.0 | 66.0 | 61.0 | 59.0 | 43.0 | 40.0 | 45.0 | 49.0
Bottom third | Up | 52.0 | 55.0 | 50.0 | 46.7 | 53.0 | 50.0 | 55.0 | 58.0
Middle third | Off | 53.0 | 56.0 | 51.0 | 49.0 | 50.0 | 48.0 | 51.0 | 53.0
Middle third | Down | 57.0 | 61.0 | 54.0 | 52.0 | 46.0 | 43.0 | 48.0 | 51.0
Middle third | Up | 49.0 | 51.0 | 48.0 | 45.0 | 56.0 | 53.0 | 58.0 | 61.0
Top third | Off | 49.0 | 52.0 | 47.0 | 45.0 | 52.0 | 56.0 | 50.0 | 48.0
Top third | Down | 52.0 | 56.0 | 50.0 | 47.0 | 47.5 | 50.0 | 46.9 | 43.8
Top third | Up | 45.0 | 48.0 | 44.0 | 41.0 | 60.0 | 65.0 | 58.3 | 53.3
Above range | Off | 47.0 | 50.0 | 45.0 | 43.0 | 55.0 | 57.0 | 54.0 | 51.0
Above range | Down | 50.0 | 53.0 | 47.0 | 44.0 | 51.0 | 54.0 | 49.0 | 47.0
Above range | Up | 43.0 | 46.0 | 42.0 | 39.0 | 62.0 | 64.0 | 60.0 | 57.0
Use small second-line hours/day samples. In Bullish Bottom third USD Down Investable show exactly200/40; in Bearish Top third USD Up Investable exactly120/30.
For Bullish Bottom third, USD Off samples in the four volatility columns are1000/180,500/100,250/60,250/65; USDDown400/85,200/40,100/24,100/26; USDUp300/70,160/35,80/20,60/18.
For Bearish Top third, USDOff1000/180,400/100,400/100,200/60; USDDown400/90,160/45,160/45,80/25; USDUp300/70,120/30,120/30,60/18.
For all other cells use plausible illustrative hours/day counts, sensible sum and minimum relationships. Below50close% neutralwhite,50white,55 faint shade,60 moderate,65+ strong but muted shade. Bullish UP band shades GREEN as frequency increases. Bearish DOWN band shades RED as frequency increases. This hue encodes closing direction, intensity encodes frequency. Regular charcoal percentage text, not green/red text on colored background. All rows normalweight. Small inline legend "Darker = more frequent close · Green = up · Red = down".
Override Below range USD Up Uninvestable in left bullish block to75.0%† with8/2. Gray unfilled, excluded from shading. Include †legend.
Two thin charcoal outlines show the original preferred entry examples: Bullish/Bottom third/USDDown/Investable66.0%, and Bearish/Top third/USDUp/Investable65.0%. Do not call them optimal. Other cells such as bearish above-range can show64.0% in the red band.
Below matrix show ONLY ONE selected-cell detail strip for bullish example: "Bullish · Bottom third | USD Down · Investable | Up 66.0% | Baseline58.0% | Δ+8.0 pp |200 hours/40 days |95% interval59.2–72.2%".
No duplicate summary table, no extra panel. The giant matrix makes stronger directional frequencies jump out across all entry zones while keeping every value's meaning explicit.
