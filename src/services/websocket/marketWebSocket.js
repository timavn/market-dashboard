import { ENDPOINTS } from '../../constants/apiEndpoints';

export class MarketWebSocketService {
  constructor() {
    this.ws = null;
    this.subscribers = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.shouldReconnect = true;
  }

  isConnected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  connect() {
    try {
      this.shouldReconnect = true;
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.CONNECTING ||
          this.ws.readyState === WebSocket.OPEN)
      ) {
        return;
      }

      if (this.ws) {
        try {
          this.ws.close();
        } catch (_) {
          /* ignore */
        }
        this.ws = null;
      }

      const wsPort = process.env.REACT_APP_WS_PORT || 3001;
      const wsUrl = `ws://localhost:${wsPort}${ENDPOINTS.WS_MARKET_DATA}`;
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        if (this._pendingSubscribe) {
          const { channel, symbols } = this._pendingSubscribe;
          this._sendSubscribe(channel, symbols);
          this._pendingSubscribe = null;
        } else if (this._channelSymbols) {
          this._channelSymbols.forEach((symbols, channel) => {
            if (this.subscribers.has(channel)) {
              this._sendSubscribe(channel, symbols);
            }
          });
        }
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        try {
          const data = JSON.parse(event.data);
          this.notifySubscribers(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      socket.onclose = () => {
        if (this.ws !== socket) return;
        console.log('WebSocket disconnected');
        this.handleReconnect();
      };

      socket.onerror = (error) => {
        if (this.ws !== socket) return;
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Error connecting to WebSocket:', error);
    }
  }

  handleReconnect() {
    if (!this.shouldReconnect) {
      return;
    }
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        this.connect();
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  subscribe(channel, callback, options = {}) {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    this.subscribers.get(channel).add(callback);

    const symbols = Array.isArray(options.symbols) ? options.symbols : [];
    this._channelSymbols = this._channelSymbols || new Map();
    if (symbols.length) {
      this._channelSymbols.set(channel, symbols);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe(channel, symbols);
    } else if (symbols.length) {
      this._pendingSubscribe = { channel, symbols };
    }

    return () => {
      const channelSubscribers = this.subscribers.get(channel);
      if (channelSubscribers) {
        channelSubscribers.delete(callback);
        if (channelSubscribers.size === 0) {
          this.subscribers.delete(channel);
          if (this._channelSymbols) {
            this._channelSymbols.delete(channel);
          }
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              action: 'unsubscribe',
              channel: channel,
            }));
          }
        }
      }
    };
  }

  _sendSubscribe(channel, symbols = []) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._pendingSubscribe = { channel, symbols };
      return;
    }
    const payload = {
      action: 'subscribe',
      channel,
    };
    if (symbols.length) {
      payload.symbols = symbols.map(s => String(s).toUpperCase());
    }
    this.ws.send(JSON.stringify(payload));
  }

  updateSymbols(channel, symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return;
    this._channelSymbols = this._channelSymbols || new Map();
    this._channelSymbols.set(channel, symbols);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._pendingSubscribe = { channel, symbols };
      return;
    }
    this.ws.send(JSON.stringify({
      action: 'update_symbols',
      channel,
      symbols: symbols.map(s => String(s).toUpperCase()),
    }));
  }

  notifySubscribers(data) {
    const { channel, payload } = data;
    const channelSubscribers = this.subscribers.get(channel);
    
    if (channelSubscribers) {
      channelSubscribers.forEach(callback => {
        try {
          callback(payload);
        } catch (error) {
          console.error('Error in subscriber callback:', error);
        }
      });
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.shouldReconnect = false;
    this.subscribers.clear();
  }
}

// Singleton instance
export const marketWebSocket = new MarketWebSocketService();