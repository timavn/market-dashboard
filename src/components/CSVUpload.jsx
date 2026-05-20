import React, { useState, useRef, useEffect } from 'react';
import { Card, Button, Text, Title, Badge, Flex } from '@tremor/react';
import { PresignedUploadService } from '../services/presignedUploadService';
import { MarketDataService } from '../services/api/marketDataService';
import LoadingIndicator from './common/LoadingIndicator';

const CSVUpload = ({
  onUploadSuccess,
  onUploadError,
  dataSource,
  reconciliationWarnings = [],
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [lastUploadTime, setLastUploadTime] = useState(null);
  const [viewingDate, setViewingDate] = useState(null);
  const [showWarning, setShowWarning] = useState(false);
  const [warningData, setWarningData] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const fileInputRef = useRef(null);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      // Show immediate feedback
      setIsUploading(true);
      setUploadStatus({ type: 'info', message: 'Preparing upload...' });
      checkDateAndUpload(files[0]);
    }
  };

  const handleFileSelect = (e) => {
    const files = e.target.files;
    if (files.length > 0) {
      // Show immediate feedback
      setIsUploading(true);
      setUploadStatus({ type: 'info', message: 'Preparing upload...' });
      checkDateAndUpload(files[0]);
    }
  };

  const handleConfirmOldUpload = async () => {
    setShowWarning(false);
    if (pendingFile) {
      await performUpload(pendingFile);
      setPendingFile(null);
    }
  };

  const handleCancelUpload = () => {
    setShowWarning(false);
    setPendingFile(null);
    setWarningData(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const extractDateFromFilename = (filename) => {
    const dateMatch = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
      return new Date(dateMatch[1], parseInt(dateMatch[2]) - 1, dateMatch[3]);
    }
    return null;
  };

  const checkDateAndUpload = async (file) => {
    const csvDate = extractDateFromFilename(file.name);
    let shouldProceed = true;

    // Only check date if we can extract it from filename
    if (csvDate) {
      try {
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';

        // Add timeout to date check (2 seconds max)
        const dateCheckPromise = fetch(`${backendUrl}/api/portfolio`);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Date check timeout')), 2000)
        );

        try {
          const response = await Promise.race([dateCheckPromise, timeoutPromise]);
          const portfolioData = await response.json();

          const lastUpdatedStr = portfolioData.lastUpdated;
          if (lastUpdatedStr && lastUpdatedStr !== 'Schwab Integration Pending') {
            const dateMatch = lastUpdatedStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (dateMatch) {
              const existingDate = new Date(dateMatch[3], parseInt(dateMatch[1]) - 1, dateMatch[2]);

              if (csvDate < existingDate) {
                // Show warning dialog
                setIsUploading(false); // Pause upload state for warning
                setWarningData({
                  csvDate: csvDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                  existingDate: existingDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                  file: file
                });
                setShowWarning(true);
                setPendingFile(file);
                setUploadStatus(null);
                return; // Don't proceed until user confirms
              }
            }
          }
        } catch (timeoutError) {
          // Date check timed out or failed - proceed with upload anyway
          console.warn('Date check timeout or failed, proceeding with upload:', timeoutError);
          // Continue to upload
        }
      } catch (error) {
        // Date check failed - proceed with upload anyway
        console.warn('Date check failed, proceeding with upload:', error);
        // Continue to upload
      }
    }

    // Proceed with upload
    if (shouldProceed) {
      await performUpload(file);
    }
  };

  const performUpload = async (file) => {
    setIsUploading(true);

    try {
      // Validate CSV
      PresignedUploadService.validateCSV(file);

      // Update status: Uploading to S3
      setUploadStatus({ type: 'info', message: 'Uploading to S3...' });

      // Upload to S3
      const result = await PresignedUploadService.uploadCSV(file);

      // Update status: Processing (Lambda is processing)
      setUploadStatus({ type: 'info', message: 'Processing...' });

      setLastUploadTime(new Date().toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }));

      // Update status: Complete
      setUploadStatus({
        type: 'success',
        message: `Portfolio updated successfully! Processing in background...`
      });

      if (onUploadSuccess) {
        onUploadSuccess(result);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      // Trigger refresh immediately (no 5-second delay)
      window.dispatchEvent(new CustomEvent('portfolioRefresh'));

      // Clear status after 5 seconds
      setTimeout(() => {
        setUploadStatus(null);
      }, 5000);

    } catch (error) {
      console.error('Upload error:', error);
      setUploadStatus({
        type: 'error',
        message: error.message
      });

      if (onUploadError) {
        onUploadError(error);
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  // Fetch portfolio data to get the market day being viewed
  useEffect(() => {
    const fetchViewingDate = async () => {
      try {
        const portfolioData = await MarketDataService.getPortfolio();
        const lastUpdatedStr = portfolioData?.lastUpdated;

        if (lastUpdatedStr &&
          lastUpdatedStr !== 'Schwab Integration Pending' &&
          lastUpdatedStr !== 'No portfolio data - upload a Schwab CSV to get started') {
          // Extract date from lastUpdated string (format: "MM/DD/YYYY, HH:MM AM/PM PST / HH:MM AM/PM EST")
          // Example: "01/11/2026, 8:19 AM PST / 11:19 AM EST"
          const dateMatch = lastUpdatedStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);

          if (dateMatch && dateMatch.length >= 4) {
            const year = dateMatch[3];
            const month = parseInt(dateMatch[1]) - 1; // Month is 0-indexed
            const day = dateMatch[2];
            const date = new Date(year, month, day);

            // Verify date is valid
            if (!isNaN(date.getTime())) {
              // Format as "Month Day, Year" (e.g., "January 11, 2026")
              const formattedDate = date.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric'
              });
              setViewingDate(formattedDate);
            }
          }
        }
      } catch (error) {
        console.warn('Failed to fetch viewing date:', error);
        // Don't set viewingDate if fetch fails
      }
    };

    // Fetch immediately
    fetchViewingDate();

    // Listen for portfolio refresh events to update viewing date
    const handlePortfolioRefresh = () => {
      // Small delay to allow backend to process
      setTimeout(() => {
        fetchViewingDate();
      }, 3000);
    };

    window.addEventListener('portfolioRefresh', handlePortfolioRefresh);

    return () => {
      window.removeEventListener('portfolioRefresh', handlePortfolioRefresh);
    };
  }, []); // Only run once on mount

  return (
    <div>
      {/* Upload Area */}
      <Card
        className={`cursor-pointer transition-all rounded-lg ${isDragging ? 'ring-2 ring-blue-500 bg-blue-50' : 'hover:bg-gray-50'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleButtonClick}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        {isUploading ? (
          <LoadingIndicator
            label={uploadStatus?.message || 'Uploading...'}
            size="sm"
            centered
            className="py-4"
          />
        ) : (
          <div className="text-center py-4">
            <Text className="text-base font-semibold mb-1">
              📁 {lastUploadTime ? `Updated ${lastUploadTime}` : 'Upload Schwab CSV'}
            </Text>
            {viewingDate ? (
              <Text className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Viewing: {viewingDate}
              </Text>
            ) : null}
            {dataSource === 'ibkr_api' && (
              <Text className="text-xs text-gray-500 mt-1">
                IBKR API is active. CSV upload remains available as a fallback.
              </Text>
            )}
            {reconciliationWarnings?.length > 0 && (
              <Text className="text-xs text-amber-700 mt-1">
                Reconciliation: {reconciliationWarnings.slice(0, 2).join('; ')}
                {reconciliationWarnings.length > 2 ? '…' : ''}
              </Text>
            )}
            <Text className="text-sm text-gray-500 mt-1">
              Click or drag CSV file here
            </Text>
          </div>
        )}
      </Card>

      {/* Status Message */}
      {uploadStatus && !isUploading && (
        <Card className={`mt-3 rounded-lg ${uploadStatus.type === 'success'
            ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
            : uploadStatus.type === 'error'
              ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
              : 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800'
          }`}>
          <Badge
            color={uploadStatus.type === 'success' ? 'emerald' : uploadStatus.type === 'error' ? 'red' : 'blue'}
            size="lg"
          >
            {uploadStatus.message}
          </Badge>
        </Card>
      )}

      {/* Warning Dialog */}
      {showWarning && warningData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="max-w-md mx-4 bg-amber-50 border-amber-300 dark:bg-amber-900/20 dark:border-amber-800">
            <Flex className="mb-4" alignItems="center">
              <Text className="text-3xl mr-3">⚠️</Text>
              <Title className="dark:text-white">Older Statement Detected</Title>
            </Flex>

            <Text className="mb-4 dark:text-gray-300">
              The CSV file you're trying to upload appears to be from an older date:
            </Text>

            <Card className="mb-4 bg-white dark:bg-gray-800">
              <Flex justifyContent="between" alignItems="center" className="mb-2">
                <Text className="font-semibold dark:text-white">CSV Statement Date:</Text>
                <Badge color="red">{warningData.csvDate}</Badge>
              </Flex>
              <Flex justifyContent="between" alignItems="center">
                <Text className="font-semibold dark:text-white">Current Portfolio Date:</Text>
                <Badge color="emerald">{warningData.existingDate}</Badge>
              </Flex>
            </Card>

            <Text className="text-xs text-gray-600 dark:text-gray-400 mb-4">
              Uploading an older statement will overwrite your current portfolio data.
              Are you sure you want to continue?
            </Text>

            <Flex className="gap-3">
              <Button
                onClick={handleCancelUpload}
                variant="secondary"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmOldUpload}
                color="red"
                className="flex-1"
              >
                Upload Anyway
              </Button>
            </Flex>
          </Card>
        </div>
      )}
    </div>
  );
};

export default CSVUpload;
