import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getLeveragedProducts } from '../../../constants/leveragedProductCatalog';
import PortfolioMetricCell from './PortfolioMetricCell';
import { leveragedDirectionClass } from './leveragedProductPresentation';

const LEVERAGED_PRODUCTS_FIT_GUTTER_PX = 4;

export const calculateLeveragedProductsFitScale = (availableWidth, contentWidth) => {
  const available = Number(availableWidth);
  const content = Number(contentWidth);
  if (!Number.isFinite(available) || !Number.isFinite(content) || available <= 0 || content <= 0) {
    return 1;
  }
  const usableWidth = Math.max(1, available - LEVERAGED_PRODUCTS_FIT_GUTTER_PX);
  return Math.min(1, usableWidth / content);
};

function LeveragedProductsFitRow({ symbol, signature, children }) {
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const [scale, setScale] = useState(1);

  const fitContent = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const naturalWidth = Math.max(content.scrollWidth, content.offsetWidth);
    const nextScale = calculateLeveragedProductsFitScale(viewport.clientWidth, naturalWidth);
    setScale((currentScale) => (
      Math.abs(currentScale - nextScale) < 0.0005 ? currentScale : nextScale
    ));
  }, []);

  useLayoutEffect(() => {
    fitContent();
    let cancelled = false;
    const ResizeObserverCtor = typeof window !== 'undefined' ? window.ResizeObserver : null;
    const handleResize = () => fitContent();
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(handleResize) : null;
    if (observer) {
      if (viewportRef.current) observer.observe(viewportRef.current);
      if (contentRef.current) observer.observe(contentRef.current);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', handleResize);
    }
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) fitContent();
      });
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (!observer && typeof window !== 'undefined') {
        window.removeEventListener('resize', handleResize);
      }
    };
  }, [fitContent, signature]);

  return (
    <div
      ref={viewportRef}
      className="pcv2-leveraged-products"
      data-testid={`leveraged-products-${symbol}`}
      data-fit-scale={scale.toFixed(4)}
      style={{ '--pcv2-leveraged-products-scale': scale }}
    >
      <div ref={contentRef} className="pcv2-leveraged-products-content">
        {children}
      </div>
    </div>
  );
}

export default function LeveragedProductsCell({ symbol, onSelect }) {
  const products = getLeveragedProducts(symbol);
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();

  if (products.length === 0) {
    return (
      <PortfolioMetricCell
        value="—"
        meta="No current leveraged product mapping"
        title={`No current daily leveraged product mapping is configured for ${normalizedSymbol}.`}
        tone="is-muted"
        className="pcv2-leveraged-products-cell"
        spanClassName="pcv2-intel-span-4"
      />
    );
  }

  return (
    <PortfolioMetricCell
      value={null}
      meta={products.map((item) => `${item.ticker} ${item.leverage}`).join(' · ')}
      title={`Leveraged product options for ${normalizedSymbol}.`}
      className="pcv2-leveraged-products-cell"
      spanClassName="pcv2-intel-span-4"
    >
      <LeveragedProductsFitRow
        symbol={normalizedSymbol}
        signature={products.map((item) => `${item.ticker}:${item.leverage}`).join('|')}
      >
        {products.map((product) => (
          <button
            key={product.ticker}
            type="button"
            className={`pcv2-leveraged-product-link ${leveragedDirectionClass(product.leverage)}${product.matchType === 'proxy' ? ' is-proxy' : ''}`}
            aria-label={`View ${product.ticker} ${product.leverage} details for ${normalizedSymbol}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect({ baseSymbol: normalizedSymbol, product });
            }}
          >
            <span className="pcv2-leveraged-product-ticker">{product.ticker}</span>{' '}
            <span>{product.leverage}</span>
          </button>
        ))}
      </LeveragedProductsFitRow>
    </PortfolioMetricCell>
  );
}
