---
name: market-questions
description: Answer general market and security questions about Nasdaq, daily movers, prices, history, fundamentals, or macro data using the dashboard's verified market APIs.
---

# Market questions

Use the smallest relevant read: `get_live_market_snapshot` for current exact-symbol prices, `get_market_history` for history, `get_company_fundamentals` for company context, and `get_macro_series` for macro releases. `get_dashboard_context` supplies market backdrop and the bounded `dailyMarket` informational rankings. Use `get_market_situation_context` specifically for the published Market Situation and its volatility evidence. If Tim asks what a publisher says, use `research-questions`.

For “what is happening with Nasdaq,” resolve the index or instrument from context. Nasdaq Composite, Nasdaq-100, QQQ, and futures are distinct; name the exact returned instrument and explicitly identify any proxy. When it matters and the request cannot resolve the intended index, ask a short clarification while answering the part supported by available evidence. A price move does not establish its cause; distinguish a verified move, cited catalyst/research, and analyst inference.

## Daily movers

Read `get_dashboard_context` and use only the code-produced `dailyMarket` rankings. Preserve its stated universe, constituent coverage, session date, source, and original observation. The available S&P 500/SPY-constituent roster is not all US stocks or the Nasdaq-100 roster. Do not silently substitute it for a requested universe or construct a market-wide rank from a few quotes, the user's holdings, or research tickers.

Unless Tim explicitly asks for dollar price changes, movers mean the returned session percentage return, with positive and negative sides distinguished. State the ranking's actual metric and universe. For “moves most” without a direction, use the code-produced winners and losers rather than inventing an absolute rank. A retained `D`, `DELAYED`, or `LAST CLOSE` observation is dated informational context; never call it today's live leader or an executable quote. Missing or contaminated rankings remain unavailable. Keep comparable groups and their original session intact.

## Format

Answer in one or two sentences, then a small table only for useful comparisons: `Ticker | Security | Move | Observation` for securities, or `Metric | Reading | Date` for macro context. Add a short explanation of what changes interpretation and cite the actual evidence. Do not force a portfolio review, recommendations, an exhaustive roster, or technical API status into an ordinary market question.
