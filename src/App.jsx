import React, { useEffect, useState } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { PortfolioProvider } from './context/PortfolioContext';
import PortfolioDashboard from './components/Dashboard/PortfolioDashboard';
import HowItWorksPage from './components/HowItWorks/HowItWorksPage';
import ProcessPage from './components/Process/ProcessPage';
import {
  getProcessDocument,
  getProcessDocumentByRoute,
} from './constants/processDocuments';

const HOW_IT_WORKS_HASH = '#/how-it-works';
const PROCESS_HASH = getProcessDocument('the-process').route;
const LEGACY_WHITE_PAPER_HASH = '#/white-paper';

const getAppRoute = () => {
  if (typeof window === 'undefined') return { page: 'dashboard', documentId: null };
  if (window.location.hash === LEGACY_WHITE_PAPER_HASH) {
    return { page: 'process', documentId: 'the-process' };
  }
  const processDocument = getProcessDocumentByRoute(window.location.hash);
  if (processDocument?.published) {
    return { page: 'process', documentId: processDocument.id };
  }
  if (window.location.hash === HOW_IT_WORKS_HASH) return { page: 'how-it-works', documentId: null };
  return { page: 'dashboard', documentId: null };
};

function App() {
  const [route, setRoute] = useState(getAppRoute);

  useEffect(() => {
    const handleHashChange = () => {
      if (window.location.hash === LEGACY_WHITE_PAPER_HASH) {
        window.history.replaceState(null, '', PROCESS_HASH);
      }
      setRoute(getAppRoute());
    };
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Fix scroll lock issue with Tremor Select dropdowns and prevent scroll propagation
  useEffect(() => {
    // Check if a dropdown is open
    const hasOpenDropdown = () => {
      return document.querySelector('[role="listbox"]:not([hidden]), [data-headlessui-portal] [role="listbox"], [data-radix-popper-content-wrapper] [role="listbox"]:not([style*="display: none"])');
    };

    // Ensure body scroll is always enabled, but allow brief moments for dropdown positioning
    const ensureScrollEnabled = () => {
      // Only force scroll enabled if no dropdown is open
      if (!hasOpenDropdown()) {
        if (document.body.style.overflow === 'hidden') {
          document.body.style.overflow = 'auto';
        }
        if (document.documentElement.style.overflow === 'hidden') {
          document.documentElement.style.overflow = 'auto';
        }
      }
    };

    // Prevent scroll propagation from dropdown to body
    const handleWheel = (e) => {
      const dropdown = e.target.closest('[role="listbox"], [data-headlessui-portal], [data-radix-popper-content-wrapper]');
      if (dropdown) {
        // Always stop propagation when inside dropdown to prevent body scroll
        e.stopPropagation();
        
        // Check if dropdown is scrollable and at scroll boundaries
        const isScrollable = dropdown.scrollHeight > dropdown.clientHeight;
        const isAtTop = dropdown.scrollTop === 0;
        const isAtBottom = dropdown.scrollTop + dropdown.clientHeight >= dropdown.scrollHeight - 1;
        
        // If at scroll boundary, prevent default to stop any further scrolling
        if (isScrollable) {
          if ((isAtTop && e.deltaY < 0) || (isAtBottom && e.deltaY > 0)) {
            e.preventDefault();
          }
        }
      }
    };

    // Prevent touch scroll propagation (for mobile)
    const handleTouchMove = (e) => {
      const dropdown = e.target.closest('[role="listbox"], [data-headlessui-portal], [data-radix-popper-content-wrapper]');
      if (dropdown) {
        e.stopPropagation();
      }
    };

    // Check immediately
    ensureScrollEnabled();

    // Set up interval to continuously check and fix (less aggressive)
    const interval = setInterval(ensureScrollEnabled, 200);

    // Also use MutationObserver to watch for style changes
    const observer = new MutationObserver((mutations) => {
      // Delay the check slightly to allow dropdowns to open
      setTimeout(ensureScrollEnabled, 50);
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['style'],
      subtree: true
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
      subtree: true
    });

    // Add scroll event listeners to prevent propagation
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });

    return () => {
      clearInterval(interval);
      observer.disconnect();
      document.removeEventListener('wheel', handleWheel, { capture: true });
      document.removeEventListener('touchmove', handleTouchMove, { capture: true });
    };
  }, []);

  return (
    <ThemeProvider>
      <div className="App">
        {route.page === 'process' ? (
          <ProcessPage
            key={route.documentId}
            documentId={route.documentId}
            onBack={() => { window.location.hash = ''; }}
          />
        ) : route.page === 'how-it-works' ? (
          <HowItWorksPage onBack={() => { window.location.hash = ''; }} />
        ) : (
          <PortfolioProvider>
            <PortfolioDashboard onOpenProcess={() => { window.location.hash = PROCESS_HASH.slice(1); }} />
          </PortfolioProvider>
        )}
      </div>
    </ThemeProvider>
  );
}

export default App;
