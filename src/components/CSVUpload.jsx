import React, { useState, useRef } from 'react';
import { Card, Button, Text, Title, Badge, Flex } from '@tremor/react';
import { PresignedUploadService } from '../services/presignedUploadService';

const CSVUpload = ({ onUploadSuccess, onUploadError }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [lastUploadTime, setLastUploadTime] = useState(null);
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
      checkDateAndUpload(files[0]);
    }
  };

  const handleFileSelect = (e) => {
    const files = e.target.files;
    if (files.length > 0) {
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
    try {
      const csvDate = extractDateFromFilename(file.name);

      if (csvDate) {
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
        const response = await fetch(`${backendUrl}/api/portfolio`);
        const portfolioData = await response.json();

        const lastUpdatedStr = portfolioData.lastUpdated;
        if (lastUpdatedStr && lastUpdatedStr !== 'Schwab Integration Pending') {
          const dateMatch = lastUpdatedStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (dateMatch) {
            const existingDate = new Date(dateMatch[3], parseInt(dateMatch[1]) - 1, dateMatch[2]);

            if (csvDate < existingDate) {
              setWarningData({
                csvDate: csvDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                existingDate: existingDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                file: file
              });
              setShowWarning(true);
              setPendingFile(file);
              return;
            }
          }
        }
      }

      await performUpload(file);

    } catch (error) {
      console.warn('Date check failed, proceeding with upload:', error);
      await performUpload(file);
    }
  };

  const performUpload = async (file) => {
    setIsUploading(true);
    setUploadStatus(null);

    try {
      PresignedUploadService.validateCSV(file);
      const result = await PresignedUploadService.uploadCSV(file);
      
      setLastUploadTime(new Date().toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }));

      setUploadStatus({
        type: 'success',
        message: `Portfolio updated successfully!`
      });

      if (onUploadSuccess) {
        onUploadSuccess(result);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('portfolioRefresh'));
      }, 5000);

      setTimeout(() => {
        setUploadStatus(null);
      }, 3000);

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
          <div className="flex items-center justify-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent mr-3"></div>
            <Text>Uploading...</Text>
          </div>
        ) : (
          <div className="text-center py-4">
            <Text className="text-base font-semibold mb-1">
              📁 {lastUploadTime ? `Updated ${lastUploadTime}` : 'Upload Schwab CSV'}
            </Text>
            <Text className="text-sm text-gray-500">
              Click or drag CSV file here
            </Text>
          </div>
        )}
      </Card>

      {/* Status Message */}
      {uploadStatus && (
        <Card className={`mt-3 rounded-lg ${uploadStatus.type === 'success' ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800' : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'}`}>
          <Badge 
            color={uploadStatus.type === 'success' ? 'emerald' : 'red'}
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
