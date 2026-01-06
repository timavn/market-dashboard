# Performance Tracking - Quick Start Guide

## How It Works

The Performance Tracking tab displays your portfolio's performance metrics, equity curve, and benchmark comparisons. It requires:

1. **Backend server running** on port 3001
2. **Portfolio data uploaded** via CSV files from Schwab
3. **DynamoDB tables** set up (if using AWS backend)

## Getting Started

### Step 1: Start the Backend Server

Make sure your backend server is running:

```bash
npm run server
# or
node server.js
```

The server should start on `http://localhost:3001`

### Step 2: Upload Your Schwab CSV

1. Export your portfolio positions from Schwab as a CSV file
2. **Important**: Name your file with a date, e.g., `portfolio_2025-01-15.csv`
   - The date format should be: `YYYY-MM-DD`
   - Example: `portfolio_2025-01-15.csv` or `schwab_positions_2025-01-15.csv`
3. Go to the **Portfolio Metrics** section on the main dashboard
4. Click or drag your CSV file to upload it
5. The file will be uploaded to S3 and processed automatically

### Step 3: View Performance Tracking

1. Click the **Performance Tracking** button/tab in the dashboard
2. You should see:
   - Equity curve with drawdowns
   - Performance metrics (Sharpe ratio, max drawdown, volatility, etc.)
   - Benchmark comparisons
   - Daily returns distribution

## Troubleshooting

### Error: "Request failed with status code 404"

This means the backend server isn't running or isn't accessible:

1. **Check if server is running:**
   ```bash
   # Should see output like:
   # 🚀 Server running on port 3001
   ```

2. **Check backend URL:**
   - The frontend expects the backend at `http://localhost:3001`
   - Make sure no firewall is blocking the connection

3. **Check browser console:**
   - Open browser DevTools (F12)
   - Look for network errors in the Console tab
   - Check if requests to `/api/performance/*` are failing

### Error: "No performance data available"

This means you haven't uploaded any portfolio data yet:

1. Upload a Schwab CSV file (see Step 2 above)
2. Wait a few seconds for processing
3. Refresh the Performance Tracking tab

### CSV Upload Issues

If CSV upload fails:

1. **Check file format:**
   - Must be a `.csv` file
   - Should contain columns: Symbol, Description, Qty, Price, Mkt Val, etc.
   - File size must be under 10MB

2. **Check filename:**
   - Should include a date: `portfolio_2025-01-15.csv`
   - Date format: `YYYY-MM-DD`

3. **Check AWS setup:**
   - S3 bucket `market-dashboard-csv-data` must exist
   - Lambda function `csv-processor` must be deployed
   - DynamoDB tables must be created

## CSV File Format

Your Schwab CSV should have these columns (Schwab exports include these automatically):

- **Symbol**: Stock/ETF ticker symbol
- **Description**: Security name
- **Qty (Quantity)**: Number of shares
- **Price**: Current price per share
- **Mkt Val (Market Value)**: Total market value
- **Gain $ (Gain/Loss $)**: Unrealized gain/loss in dollars
- **Gain % (Gain/Loss %)**: Unrealized gain/loss percentage
- **Security Type**: Type of security (Stock, ETF, etc.)

## Performance Metrics Explained

- **Sharpe Ratio**: Risk-adjusted return measure (higher is better)
- **Max Drawdown**: Largest peak-to-trough decline (lower is better)
- **Volatility**: Standard deviation of returns (lower = less risk)
- **Win Rate**: Percentage of days with positive returns
- **Alpha**: Excess return vs benchmark
- **Beta**: Sensitivity to market movements

## Next Steps

After your first upload:

1. Upload new CSV files regularly (daily/weekly) to track performance over time
2. Each upload creates a new snapshot with a date
3. The system calculates performance metrics automatically
4. Compare your performance against benchmarks (SPY, QQQ, etc.)

## Need Help?

- Check the browser console for detailed error messages
- Verify AWS credentials are configured correctly
- Ensure DynamoDB tables exist (if using AWS backend)
- Check server logs for processing errors

