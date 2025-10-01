import { useState, useEffect, useCallback } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { marketWebSocket } from '../services/websocket/marketWebSocket';

export const useMarketData = (symbols = []) => {
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

  // WebSocket real-time updates
  useEffect(() => {
    if (!connected) {
      marketWebSocket.connect();
      setConnected(true);
    }

    const unsubscribe = marketWebSocket.subscribe('quotes', (update) => {
      setData(prevData => ({
        ...prevData,
        [update.symbol]: {
          ...prevData[update.symbol],
          ...update
        }
      }));
    });

    return () => {
      unsubscribe();
    };
  }, [connected]);

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
    
    // Set up periodic refresh every 30 seconds
    const interval = setInterval(fetchVIX, 30000);
    
    return () => clearInterval(interval);
  }, [fetchVIX]);

  return {
    vixData,
    loading,
    error,
    refetch: fetchVIX
  };
};