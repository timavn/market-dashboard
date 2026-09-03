import React, { useEffect, useState } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { PortfolioProvider } from './context/PortfolioContext';
import PortfolioDashboard from './components/Dashboard/PortfolioDashboard';
import HowItWorksPage from './components/HowItWorks/HowItWorksPage';
import PersistentSurface from './components/common/PersistentSurface';
import { isDashboardSessionRetentionEnabled } from './config/dashboardSessionRetention';
import {
  getProcessDocument,
  getProcessDocumentByRoute,
} from './constants/processDocuments';

const HOW_IT_WORKS_HASH = '#/how-it-works';
const PROCESS_HASH = getProcessDocument('the-process').route;
const LEGACY_WHITE_PAPER_HASH = '#/white-paper';
const LEGACY_PROCESS_COMPANION_HASHES = new Set([
  '#/process/principles',
  '#/process/playbook',
]);

const getRouteWithoutSectionQuery = (hash) => String(hash || '').split('?')[0];

const getAppRoute = () => {
  if (typeof window === 'undefined') return { page: 'dashboard', documentId: null };
  const routeHash = getRouteWithoutSectionQuery(window.location.hash);
  if (routeHash === LEGACY_WHITE_PAPER_HASH || LEGACY_PROCESS_COMPANION_HASHES.has(routeHash)) {
    return { page: 'process', documentId: 'the-process' };
  }
  const processDocument = getProcessDocumentByRoute(routeHash);
  if (processDocument?.published) {
    return { page: 'process', documentId: processDocument.id };
  }
  if (window.location.hash === HOW_IT_WORKS_HASH) return { page: 'how-it-works', documentId: null };
  return { page: 'dashboard', documentId: null };
};

function App() {
  const [route, setRoute] = useState(getAppRoute);
  const retentionEnabled = isDashboardSessionRetentionEnabled();

  useEffect(() => {
    const handleNavigation = () => {
      const routeHash = getRouteWithoutSectionQuery(window.location.hash);
      if (routeHash === LEGACY_WHITE_PAPER_HASH || LEGACY_PROCESS_COMPANION_HASHES.has(routeHash)) {
        window.history.replaceState(null, '', PROCESS_HASH);
      }
      setRoute(getAppRoute());
    };
    handleNavigation();
    window.addEventListener('hashchange', handleNavigation);
    window.addEventListener('popstate', handleNavigation);
    return () => {
      window.removeEventListener('hashchange', handleNavigation);
      window.removeEventListener('popstate', handleNavigation);
    };
  }, []);

  const openProcess = () => {
    if (route.page === 'process') return;
    window.history.pushState({ ...(window.history.state || {}), processOverlayEntry: true }, '', PROCESS_HASH);
    setRoute(getAppRoute());
  };

  const navigateProcess = (targetRoute) => {
    const historyMethod = route.page === 'process' ? 'replaceState' : 'pushState';
    const openedFromDashboard = route.page !== 'process'
      || window.history.state?.processOverlayEntry === true;
    const nextHistoryState = { ...(window.history.state || {}) };
    if (openedFromDashboard) nextHistoryState.processOverlayEntry = true;
    window.history[historyMethod](
      nextHistoryState,
      '',
      targetRoute,
    );
    setRoute(getAppRoute());
  };

  const closeProcess = ({ replace = false } = {}) => {
    const openedFromDashboard = window.history.state?.processOverlayEntry === true;
    if (!replace && openedFromDashboard && window.history.length > 1) {
      window.history.back();
      return;
    }
    const dashboardUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, '', dashboardUrl);
    setRoute(getAppRoute());
  };

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
        {retentionEnabled ? (
          <>
            <PortfolioProvider>
              <PersistentSurface active={route.page !== 'how-it-works'}>
                <PortfolioDashboard
                  processDocumentId={route.page === 'process' ? route.documentId : null}
                  onOpenProcess={openProcess}
                  onNavigateProcess={navigateProcess}
                  onCloseProcess={closeProcess}
                />
              </PersistentSurface>
            </PortfolioProvider>
            <PersistentSurface active={route.page === 'how-it-works'}>
              <HowItWorksPage onBack={() => { window.location.hash = ''; }} />
            </PersistentSurface>
          </>
        ) : route.page === 'how-it-works' ? (
          <HowItWorksPage onBack={() => { window.location.hash = ''; }} />
        ) : (
          <PortfolioProvider>
            <PortfolioDashboard
              processDocumentId={route.page === 'process' ? route.documentId : null}
              onOpenProcess={openProcess}
              onNavigateProcess={navigateProcess}
              onCloseProcess={closeProcess}
            />
          </PortfolioProvider>
        )}
      </div>
    </ThemeProvider>
  );
}

export default App;
