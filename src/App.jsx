import React, { useEffect, useState } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { PortfolioProvider } from './context/PortfolioContext';
import PortfolioDashboard from './components/Dashboard/PortfolioDashboard';
import SurfaceErrorBoundary from './components/common/SurfaceErrorBoundary';
import PersistentSurface from './components/common/PersistentSurface';
import {
  getProcessDocument,
  getProcessDocumentByRoute,
} from './constants/processDocuments';

const HOW_IT_WORKS_HASH = '#/how-it-works';
const PROCESS_HASH = getProcessDocument('the-process').route;
const DASHBOARD_GUIDE_HASH = getProcessDocument('dashboard-guide').route;
const LEGACY_WHITE_PAPER_HASH = '#/white-paper';
const LEGACY_PROCESS_COMPANION_HASHES = new Set([
  '#/process/principles',
  '#/process/playbook',
]);

const getRouteWithoutSectionQuery = (hash) => String(hash || '').split('?')[0];

const getAppRoute = () => {
  if (typeof window === 'undefined') return { page: 'dashboard', documentId: null };
  const routeHash = getRouteWithoutSectionQuery(window.location.hash);
  if (routeHash === HOW_IT_WORKS_HASH) {
    return { page: 'process', documentId: 'dashboard-guide' };
  }
  if (routeHash === LEGACY_WHITE_PAPER_HASH || LEGACY_PROCESS_COMPANION_HASHES.has(routeHash)) {
    return { page: 'process', documentId: 'the-process' };
  }
  const processDocument = getProcessDocumentByRoute(routeHash);
  if (processDocument?.published) {
    return { page: 'process', documentId: processDocument.id };
  }
  return { page: 'dashboard', documentId: null };
};

function App() {
  const [route, setRoute] = useState(getAppRoute);

  useEffect(() => {
    const handleNavigation = () => {
      const routeHash = getRouteWithoutSectionQuery(window.location.hash);
      if (routeHash === HOW_IT_WORKS_HASH) {
        window.history.replaceState(null, '', DASHBOARD_GUIDE_HASH);
      } else if (routeHash === LEGACY_WHITE_PAPER_HASH || LEGACY_PROCESS_COMPANION_HASHES.has(routeHash)) {
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


  return (
    <ThemeProvider>
      <div className="App">
        <SurfaceErrorBoundary>
          <PortfolioProvider>
            <PersistentSurface active eager>
              <PortfolioDashboard
                processDocumentId={route.page === 'process' ? route.documentId : null}
                onOpenProcess={openProcess}
                onNavigateProcess={navigateProcess}
                onCloseProcess={closeProcess}
              />
            </PersistentSurface>
          </PortfolioProvider>
        </SurfaceErrorBoundary>
      </div>
    </ThemeProvider>
  );
}

export default App;
