import { useState, useEffect, useCallback } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { marketWebSocket } from '../services/websocket/marketWebSocket';

export const useMarketData = (symbols = [], options = {}) => {
  const { enableRealtime = false, streamEnabled } = options;
  const realtimeOn =
    enableRealtime &&
    (streamEnabled !== undefined
      ? streamEnabled
      : process.env.REACT_APP_IBKR_STREAM_ENABLED !== 'false');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);

  // Fetch initial data
  const fetchQuotes = useCallback(async () => {
    if (symbols.length === 0) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const quotes = await MarketDataService.getQuotes(symbols);
      setData(prevData => ({ ...prevData, ...quotes }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [symbols]);

  // WebSocket real-time updates (optional)
  useEffect(() => {
    if (!realtimeOn || symbols.length === 0) {
      setConnected(false);
      return;
    }

    marketWebSocket.connect();

    const unsubscribe = marketWebSocket.subscribe(
      'quotes',
      payload => {
        const updates = Array.isArray(payload) ? payload : [payload];
        setData(prevData => {
          const next = { ...prevData };
          updates.forEach(update => {
            const key = (update.symbol || '').toUpperCase();
            if (key) next[key] = { ...next[key], ...update };
          });
          return next;
        });
        setConnected(true);
      },
      { symbols },
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, [realtimeOn, symbols.join(',')]);

  useEffect(() => {
    if (!realtimeOn || symbols.length === 0) return;
    marketWebSocket.updateSymbols('quotes', symbols);
  }, [realtimeOn, symbols.join(',')]);

  // Initial fetch
  useEffect(() => {
    fetchQuotes();
  }, [fetchQuotes]);

  return {
    data,
    loading,
    error,
    connected,
    refetch: fetchQuotes
  };
};

export const useOptionsData = (symbol) => {
  const [optionsChain, setOptionsChain] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchOptionsChain = useCallback(async () => {
    if (!symbol) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const chain = await MarketDataService.getOptionsChain(symbol);
      setOptionsChain(chain);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    fetchOptionsChain();
  }, [fetchOptionsChain]);

  return {
    optionsChain,
    loading,
    error,
    refetch: fetchOptionsChain
  };
};

export const useVIXData = () => {
  const [vixData, setVixData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchVIX = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const data = await MarketDataService.getVIXData();
      setVixData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVIX();

    // Disabled auto-refresh for now
    // const interval = setInterval(fetchVIX, 30000);
    // return () => clearInterval(interval);
  }, [fetchVIX]);

  return {
    vixData,
    loading,
    error,
    refetch: fetchVIX
  };
};