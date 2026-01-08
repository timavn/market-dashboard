import React, { useState, useEffect, useMemo } from 'react';
import { Card, Text, Title, TextInput, Button, Badge } from '@tremor/react';
import { useTheme } from '../context/ThemeContext';
import { usePortfolio } from '../context/PortfolioContext';

const UploadHistory = () => {
  const { theme } = useTheme();
  const { selectedSnapshotId, selectSnapshot } = usePortfolio();
  const [uploads, setUploads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [missingDays, setMissingDays] = useState(null);
  const [showMissingDays, setShowMissingDays] = useState(false);
  const isDark = theme === 'dark';
  
  const ITEMS_PER_PAGE = 5;
  
  // Fetch missing trading days
  useEffect(() => {
    const fetchMissingDays = async () => {
      try {
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
        const response = await fetch(`${backendUrl}/api/portfolio/missing-days`);
        if (response.ok) {
          const data = await response.json();
          setMissingDays(data);
        }
      } catch (error) {
        console.error('Error fetching missing days:', error);
      }
    };
    
    fetchMissingDays();
  }, [uploads.length]); // Refetch when uploads change
  
  // Set default selection to most recent if none selected
  useEffect(() => {
    if (!selectedSnapshotId && uploads.length > 0) {
      selectSnapshot(uploads[0].snapshotId);
    }
  }, [uploads, selectedSnapshotId, selectSnapshot]);

  useEffect(() => {
    const fetchUploads = async () => {
      try {
        setLoading(true);
        setError(null);
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
        const response = await fetch(`${backendUrl}/api/portfolio/uploads`);
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('Upload history response:', data);
        
        const uploadsList = data.uploads || [];
        setUploads(uploadsList);
        setCurrentPage(1); // Reset to first page when data loads
        
        if (uploadsList.length === 0) {
          console.warn('No uploads found in response. Data:', data);
          setError('No uploads found. Make sure you have uploaded CSV files and the backend server is connected to DynamoDB.');
        }
      } catch (error) {
        console.error('Error fetching upload history:', error);
        setError(error.message || 'Failed to load upload history. Check console for details.');
        setUploads([]);
      } finally {
        setLoading(false);
      }
    };

    fetchUploads();
    
    // Refresh when portfolio is updated
    const handleRefresh = () => {
      fetchUploads();
    };
    
    window.addEventListener('portfolioRefresh', handleRefresh);
    return () => window.removeEventListener('portfolioRefresh', handleRefresh);
  }, []);

  // Filter uploads based on search term
  const filteredUploads = useMemo(() => {
    if (!searchTerm.trim()) {
      return uploads;
    }
    const searchLower = searchTerm.toLowerCase();
    return uploads.filter(upload => {
      return (
        upload.date.toLowerCase().includes(searchLower) ||
        upload.time.toLowerCase().includes(searchLower) ||
        upload.snapshotId.toLowerCase().includes(searchLower) ||
        upload.totalValue.toString().includes(searchLower)
      );
    });
  }, [searchTerm, uploads]);

  // Calculate pagination
  const totalPages = Math.ceil(filteredUploads.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedUploads = filteredUploads.slice(startIndex, endIndex);

  // Reset to page 1 when search term changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value);
  };

  if (loading) {
    return (
      <Card className="mt-4 rounded-lg">
        <Text>Loading upload history...</Text>
      </Card>
    );
  }

  if (uploads.length === 0 && !loading) {
    return (
      <Card className="mt-4 dark:bg-gray-800 rounded-lg">
        <Title className="text-sm mb-2 dark:text-white">Upload History</Title>
        {error ? (
          <div className="space-y-2">
            <Text className="text-sm text-red-500 dark:text-red-400">
              {error}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              Check that your backend server is running and connected to AWS DynamoDB.
            </Text>
          </div>
        ) : (
          <Text className="text-sm text-gray-500 dark:text-gray-400">
            No uploads found. Upload a CSV to see history.
          </Text>
        )}
      </Card>
    );
  }

  return (
    <Card className="mt-4 dark:bg-gray-800">
      <div className="flex justify-between items-center mb-3">
        <Title className="text-sm dark:text-white">Upload History</Title>
        <div className="flex items-center gap-3">
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {filteredUploads.length} {filteredUploads.length === 1 ? 'upload' : 'uploads'}
            {searchTerm && ` (filtered from ${uploads.length})`}
          </Text>
          {missingDays && missingDays.missingCount > 0 && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setShowMissingDays(!showMissingDays)}
              className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
            >
              {showMissingDays ? 'Hide' : 'Show'} Missing Days ({missingDays.missingCount})
            </Button>
          )}
        </div>
      </div>
      
      {/* Missing Trading Days */}
      {showMissingDays && missingDays && missingDays.missingCount > 0 && (
        <Card className="mb-4 dark:bg-gray-700 border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="mb-3">
            <Title className="text-sm dark:text-white">
              Missing Trading Days for YTD ({missingDays.year})
            </Title>
            <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {missingDays.statementsCount} statements, {missingDays.totalTradingDays} trading days, {missingDays.missingCount} missing
            </Text>
          </div>
          
          <div className="space-y-3 max-h-64 overflow-y-auto">
            {Object.entries(missingDays.missingByMonth).map(([month, days]) => (
              <div key={month}>
                <Text className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">
                  {new Date(month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} ({days.length} days)
                </Text>
                <div className="flex flex-wrap gap-1">
                  {days.map(day => (
                    <Badge
                      key={day}
                      size="xs"
                      color="amber"
                      className="text-xs"
                    >
                      {new Date(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      
      {/* Search Bar */}
      <div className="mb-4">
        <TextInput
          placeholder="Search by date, time, or snapshot ID..."
          value={searchTerm}
          onValueChange={setSearchTerm}
          className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
        />
      </div>

      {/* Upload List */}
      <div className="space-y-2 mb-4">
        {paginatedUploads.length === 0 ? (
          <Text className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
            {searchTerm ? 'No uploads match your search' : 'No uploads found'}
          </Text>
        ) : (
          paginatedUploads.map((upload, index) => {
            const isSelected = upload.snapshotId === selectedSnapshotId;
            return (
            <div
              key={upload.snapshotId}
              onClick={() => selectSnapshot(upload.snapshotId)}
              className={`p-3 rounded-lg border cursor-pointer transition-all ${
                isSelected
                  ? isDark
                    ? 'bg-blue-900/30 border-blue-500 ring-2 ring-blue-500'
                    : 'bg-blue-50 border-blue-500 ring-2 ring-blue-500'
                  : isDark
                    ? 'bg-gray-700 border-gray-600 hover:bg-gray-600'
                    : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
              }`}
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Text className="text-sm font-medium dark:text-white">
                      {upload.date}
                    </Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400">
                      {upload.time}
                    </Text>
                  </div>
                  <Text className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                    {upload.snapshotId}
                  </Text>
                </div>
                <div className="text-right">
                  <Text className="text-sm font-semibold dark:text-white">
                    {formatCurrency(upload.totalValue)}
                  </Text>
                  <Text className="text-xs text-gray-500 dark:text-gray-400">
                    {upload.positionCount} positions
                  </Text>
                </div>
              </div>
              {isSelected && (
                <div className="mt-2 pt-2 border-t border-blue-500/30">
                  <Text className="text-xs text-blue-600 dark:text-blue-400 font-semibold">
                    ✓ Selected - Viewing this statement
                  </Text>
                </div>
              )}
            </div>
            );
          })
        )}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4 border-t dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
            >
              Previous
            </Button>
            <Text className="text-sm text-gray-600 dark:text-gray-400">
              Page {currentPage} of {totalPages}
            </Text>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages}
              className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
            >
              Next
            </Button>
          </div>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            Showing {startIndex + 1}-{Math.min(endIndex, filteredUploads.length)} of {filteredUploads.length}
          </Text>
        </div>
      )}
    </Card>
  );
};

export default UploadHistory;

