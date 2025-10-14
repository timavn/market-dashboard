import React, { useState, useRef } from 'react';
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
    // Try to extract date from Schwab CSV filename like "Individual-Positions-2025-10-09-223928.csv"
    const dateMatch = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
      return new Date(dateMatch[1], parseInt(dateMatch[2]) - 1, dateMatch[3]);
    }
    return null;
  };

  const checkDateAndUpload = async (file) => {
    try {
      // Extract date from filename
      const csvDate = extractDateFromFilename(file.name);

      if (csvDate) {
        // Fetch current portfolio date
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
        const response = await fetch(`${backendUrl}/api/portfolio`);
        const portfolioData = await response.json();

        // Parse the lastUpdated timestamp
        const lastUpdatedStr = portfolioData.lastUpdated;
        if (lastUpdatedStr && lastUpdatedStr !== 'Schwab Integration Pending') {
          // Extract date from "MM/DD/YYYY, H:MM AM PST / H:MM EST" format
          const dateMatch = lastUpdatedStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (dateMatch) {
            const existingDate = new Date(dateMatch[3], parseInt(dateMatch[1]) - 1, dateMatch[2]);

            // Compare dates (ignore time, only compare dates)
            if (csvDate < existingDate) {
              // CSV is older than existing data - show warning
              setWarningData({
                csvDate: csvDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                existingDate: existingDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                file: file
              });
              setShowWarning(true);
              setPendingFile(file);
              return; // Don't upload yet, wait for user confirmation
            }
          }
        }
      }

      // No date issues, proceed with upload
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
      // Validate file
      PresignedUploadService.validateCSV(file);

      // Upload using presigned URL (no credentials needed)
      const result = await PresignedUploadService.uploadCSV(file);
      
      // Set last upload time
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

      // Clear the file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      // Auto-refresh portfolio data after 5 seconds to show updated data
      setTimeout(() => {
        // Trigger a custom event to refresh portfolio data
        window.dispatchEvent(new CustomEvent('portfolioRefresh'));
      }, 5000);

      // Clear success message after 3 seconds
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
    <div className="mb-3">
      {/* Upload Button */}
      <div 
        className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
          isDragging 
            ? 'border-blue-500 bg-blue-50' 
            : 'border-gray-300 hover:border-gray-400'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleButtonClick}
        style={{
          borderColor: isDragging ? '#4682B4' : '#D3D3D3',
          backgroundColor: isDragging ? '#F0F8FF' : 'transparent',
          color: '#000080'
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        
        {isUploading ? (
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
            <span className="text-sm">Uploading...</span>
          </div>
        ) : (
          <div>
            <div className="text-sm font-bold mb-1" style={{color: '#4682B4'}}>
              📁 {lastUploadTime ? `Updated ${lastUploadTime}` : 'Upload Schwab CSV'}
            </div>
            <div className="text-xs" style={{color: '#000080'}}>
              Click or drag CSV file here
            </div>
          </div>
        )}
      </div>

      {/* Status Message */}
      {uploadStatus && (
        <div className={`mt-2 text-xs p-2 rounded ${
          uploadStatus.type === 'success'
            ? 'bg-green-100 text-green-800'
            : 'bg-red-100 text-red-800'
        }`}>
          {uploadStatus.message}
        </div>
      )}

      {/* Warning Dialog */}
      {showWarning && warningData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <div className="flex items-center mb-4">
              <div className="text-yellow-500 text-2xl mr-3">⚠️</div>
              <h3 className="text-lg font-semibold text-gray-900">Older Statement Detected</h3>
            </div>
            
            <div className="mb-4 text-sm text-gray-600">
              <p className="mb-2">
                The CSV file you're trying to upload appears to be from an older date:
              </p>
              <div className="bg-gray-50 p-3 rounded border">
                <div className="flex justify-between items-center">
                  <span className="font-medium">CSV Statement Date:</span>
                  <span className="text-red-600 font-semibold">{warningData.csvDate}</span>
                </div>
                <div className="flex justify-between items-center mt-1">
                  <span className="font-medium">Current Portfolio Date:</span>
                  <span className="text-green-600 font-semibold">{warningData.existingDate}</span>
                </div>
              </div>
              <p className="mt-3 text-xs text-gray-500">
                Uploading an older statement will overwrite your current portfolio data. 
                Are you sure you want to continue?
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={handleCancelUpload}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmOldUpload}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                Upload Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CSVUpload;
