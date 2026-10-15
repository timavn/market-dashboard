import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
const render = (onRender) => root.render(
  <React.StrictMode>
    {onRender ? <React.Profiler id="dashboard" onRender={onRender}><App /></React.Profiler> : <App />}
  </React.StrictMode>
);

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('measure')) {
  import('../scripts/testing/browser-performance-probe.mjs')
    .then(({ startBrowserPerformanceProbe }) => render(startBrowserPerformanceProbe()))
    .catch(error => { console.error('Performance probe unavailable', error); render(); });
} else {
  render();
}
