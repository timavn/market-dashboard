# Dollar Liquidity Manual Inputs

Manual global-liquidity inputs live here when a verified public FRED CSV source is not available.

Expected shape:

```csv
DATE,VALUE
2024-01-01,123.45
2024-04-01,127.89
```

Use local-currency levels for regional broad money and nominal GDP. The dashboard marks the global model as partial until every required manual input is present.

Current expected files:

- `eurozone_nominal_gdp.csv`
- `japan_nominal_gdp.csv`
- `uk_broad_money.csv`
- `uk_nominal_gdp.csv`
- `china_nominal_gdp.csv`
