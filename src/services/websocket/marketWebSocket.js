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

  connect() {
    try {
      this.shouldReconnect = true;
      const wsUrl = `ws://localhost:3001${ENDPOINTS.WS_MARKET_DATA}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.notifySubscribers(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.handleReconnect();
      };

      this.ws.onerror = (error) => {
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

  subscribe(channel, callback) {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    this.subscribers.get(channel).add(callback);

    // Send subscription message
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'subscribe',
        channel: channel
      }));
    }

    // Return unsubscribe function
    return () => {
      const channelSubscribers = this.subscribers.get(channel);
      if (channelSubscribers) {
        channelSubscribers.delete(callback);
        if (channelSubscribers.size === 0) {
          this.subscribers.delete(channel);
          // Send unsubscribe message
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              action: 'unsubscribe',
              channel: channel
            }));
          }
        }
      }
    };
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