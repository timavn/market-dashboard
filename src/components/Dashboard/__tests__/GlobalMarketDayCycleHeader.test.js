import React from 'react';
import { render, screen } from '@testing-library/react';
import GlobalMarketDayCycleHeader from '../GlobalMarketDayCycleHeader';

// Mock ResizeObserver
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

// Mock the date to a specific time for consistent testing
const mockDate = new Date('2024-01-15T14:26:00Z'); // Jan 15, 2024 at 14:26 UTC

describe('GlobalMarketDayCycleHeader - Date Boundary Line', () => {
  beforeEach(() => {
    // Mock Date to return our test date
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders date boundary line at left edge (0%)', () => {
    const { container } = render(<GlobalMarketDayCycleHeader />);
    
    // Find the date boundary line element
    const dateBoundaryLine = container.querySelector('[style*="left: \'0%\'"]');
    
    expect(dateBoundaryLine).toBeInTheDocument();
    expect(dateBoundaryLine).toHaveStyle({ left: '0%' });
    expect(dateBoundaryLine).toHaveStyle({ width: '2px' });
  });

  test('date boundary line has purple gradient styling', () => {
    const { container } = render(<GlobalMarketDayCycleHeader />);
    
    const dateBoundaryLine = container.querySelector('[style*="left: \'0%\'"]');
    const gradientDiv = dateBoundaryLine?.querySelector('div');
    
    expect(gradientDiv).toBeInTheDocument();
    expect(gradientDiv?.style.background).toContain('rgba(196, 181, 253'); // purple-300 color
  });

  test('date boundary line has correct z-index', () => {
    const { container } = render(<GlobalMarketDayCycleHeader />);
    
    const dateBoundaryLine = container.querySelector('[style*="left: \'0%\'"]');
    
    expect(dateBoundaryLine).toHaveStyle({ zIndex: '15' });
  });

  test('date boundary line spans full height of timeline', () => {
    const { container } = render(<GlobalMarketDayCycleHeader />);
    
    const dateBoundaryLine = container.querySelector('[style*="left: \'0%\'"]');
    
    expect(dateBoundaryLine).toHaveClass('absolute', 'top-0', 'bottom-0');
  });
});
