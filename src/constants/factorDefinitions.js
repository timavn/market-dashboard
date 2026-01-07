export const FACTOR_DEFINITIONS = {
  categories: {
    "Value": {
      title: "Value Factor",
      description: "The Value factor identifies companies that are undervalued relative to their fundamental worth. It typically targets stocks with low prices compared to metrics like book value, earnings, or cash flow. The premise is that these 'cheap' stocks will outperform 'expensive' stocks over the long term as the market corrects this mispricing."
    },
    "Growth": {
      title: "Growth Factor",
      description: "The Growth factor focuses on companies demonstrating strong historical or projected expansion in sales, earnings, or cash flow. Investors in this factor look for companies that are growing faster than the broader market, often willing to pay a premium for this superior growth potential."
    },
    "Quality": {
      title: "Quality Factor",
      description: "The Quality factor targets companies with healthy balance sheets, stable earnings, and high profitability. Key characteristics include high Return on Equity (ROE), stable margins, and low financial leverage. These companies tend to be more resilient during economic downturns."
    },
    "Momentum": {
      title: "Momentum Factor",
      description: "The Momentum factor capitalizes on the persistence of stock price trends. It is based on the observation that assets which have performed well in the recent past tend to continue performing well in the near future, and vice versa. This includes both price momentum (trend following) and mean reversion signals."
    },
    "Volatility & Risk": {
      title: "Volatility & Risk Factors",
      description: "This category measures a stock's sensitivity to market movements and its idiosyncratic risk. 'Low Volatility' or 'Low Beta' strategies aim to reduce portfolio risk by selecting stable stocks, which often surprisingly outperform riskier stocks over full market cycles (the Low Volatility Anomaly)."
    },
    "Liquidity & Size": {
      title: "Liquidity & Size Factors",
      description: "The Size factor (Small Cap vs. Large Cap) and Liquidity factor capture the premiums associated with investing in smaller or less liquid assets. Conversely, this model also tracks 'Large Cap' and 'High Liquidity' to gauge safety and market breadth."
    },
    "Crowding & Sentiment": {
      title: "Crowding & Sentiment",
      description: "These signals track institutional positioning and market sentiment. 'Crowding' measures how heavily invested hedge funds or other large players are in specific names. Extreme crowding can signal potential reversal risks if everyone rushes to the exit simultaneously."
    }
  },
  factors: {
    "Book-to-Price (Deep Value)": {
      title: "Book-to-Price Ratio",
      description: "A valuation ratio comparing a company's book value (assets minus liabilities) to its current market price. High Book-to-Price indicates a stock is potentially undervalued (Deep Value). It is the inverse of the Price-to-Book ratio."
    },
    "Earnings Yield": {
      title: "Earnings Yield",
      description: "The reciprocal of the P/E ratio (Earnings / Price). It represents the percentage of each dollar invested in the stock that was earned by the company. A higher earnings yield compares favorably to bond yields and indicates better value."
    },
    "Free Cash Flow Yield": {
      title: "Free Cash Flow Yield",
      description: "A financial solvency ratio that compares the free cash flow per share a company expects to earn against its market value per share. It is a more comprehensive measure of value than P/E as it accounts for capital expenditures."
    },
    "Price-to-Earnings (P/E)": {
      title: "Price-to-Earnings Ratio",
      description: "The ratio for valuing a company that measures its current share price relative to its per-share earnings. In this factor model, we typically look at the inverse or relative P/E to determine cheapness."
    },
    "Sales Growth (Top 25%)": {
      title: "Sales Growth",
      description: "Measures the rate at which a company's revenue is increasing. The 'Top 25%' designation implies a long position in the top quartile of companies with the highest year-over-year revenue growth rates."
    },
    "EPS Growth (Top 25%)": {
      title: "Earnings Per Share (EPS) Growth",
      description: "Measures the rate at which a company's profitability is increasing. Consistent EPS growth is a primary driver of stock prices over the long term. This factor goes long the fastest-growing profitable companies."
    },
    "Return on Equity (ROE)": {
      title: "Return on Equity (ROE)",
      description: "A measure of financial performance calculated by dividing net income by shareholders' equity. It indicates how effectively management is using a company's assets to create profits."
    },
    "Gross Margin Stability": {
      title: "Gross Margin Stability",
      description: "Measures the consistency of a company's gross profit margins over time. Stable or expanding margins suggest strong pricing power and competitive advantage (a 'moat')."
    },
    "Low Leverage (Low Debt/EV)": {
      title: "Low Leverage",
      description: "Identifies companies with low debt levels relative to their Enterprise Value (EV). Low leverage reduces bankruptcy risk and provides financial flexibility, a key marker of 'Quality'."
    },
    "Price Momentum (12M)": {
      title: "12-Month Price Momentum",
      description: "A standard momentum metric that looks at the total return of a stock over the past 12 months (often excluding the most recent month). Stocks with high 12M momentum tend to continue outperforming."
    },
    "Reversal (1M Mean Reversion)": {
      title: "1-Month Reversal",
      description: "A short-term signal based on the tendency of stocks that have moved explicitly in one direction over the last month to revert to their mean. This factor often goes long recent losers and shorts recent winners."
    },
    "High Beta": {
      title: "High Beta",
      description: "Beta measures a stock's volatility in relation to the overall market. High Beta stocks are more volatile and tend to amplify market moves. This factor tracks the performance of the riskiest, most sensitive stocks."
    },
    "Residual Volatility": {
      title: "Residual Volatility",
      description: "The idiosyncratic risk of a stock that cannot be explained by market returns (beta). High residual volatility often indicates uncertainty or lower quality."
    },
    "Large Cap (Top 25%)": {
      title: "Large Capitalization",
      description: "Tracks the performance of the largest companies by market cap. Large caps are generally considered more stable and liquid than small caps."
    },
    "High Liquidity (Turnover)": {
      title: "High Liquidity",
      description: "Measures stocks with high trading volume relative to shares outstanding (turnover). High liquidity reduces transaction costs and allows for easier entry/exit."
    },
    "High Short Interest": {
      title: "High Short Interest",
      description: "Tracks stocks with a high percentage of shares sold short. While traditionally a bearish signal, high short interest can lead to 'short squeezes' if positive news forces short sellers to cover positions."
    },
    "HF Concentration": {
      title: "Hedge Fund Concentration",
      description: "Measures stocks that are most widely held or have the largest weights in Hedge Fund portfolios. High concentration can be a risk if funds are forced to de-gross (sell) simultaneously."
    }
  },
  calculations: {
    "return": {
      title: "Performance Calculation",
      description: "This value represents the percentage return of the factor portfolio over the specified timeframe (e.g., 1 Day, 1 Week). \n\nFor 'Long/Short' factors, it typically represents the spread: (Return of Long Basket) - (Return of Short Basket). \n\nFor example, if 'Value' is +0.5%, it means the basket of cheap stocks outperformed the basket of expensive stocks by 50 basis points."
    }
  }
};



















