# IB Gateway setup (one-time)

The dashboard sidecar needs **IB Gateway** or **Trader Workstation** with the **socket API** enabled. The IBKR web trader does not provide this API.

## Install

1. Download **IB Gateway** from [Interactive Brokers](https://www.interactivebrokers.com/en/trading/ibgateway-stable.php).
2. Install and launch; log in (use **paper** first if available).

## API settings

In IB Gateway: **Configure → Settings → API → Settings**

| Setting | Value |
|---------|--------|
| Enable ActiveX and Socket Clients | Yes |
| Socket port | Paper: **4002**, Live: **4001** |
| Trusted IPs | **127.0.0.1** |
| Read-Only API | Recommended (sidecar uses readonly) |
| Master API client ID | **17** (or change `IB_GATEWAY_CLIENT_ID`) |

Leave Gateway running while using the dashboard.

## Verify socket port

```bash
npm run ibkr-sidecar:check
# or
IB_GATEWAY_PORT=4002 ./scripts/ibkr_sidecar/check_gateway.sh
```

## TWS instead of Gateway

| Mode | Port |
|------|------|
| TWS paper | 7497 |
| TWS live | 7496 |

Set `IB_GATEWAY_PORT` to match TWS API settings.
