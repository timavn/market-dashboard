import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3000';

/**
 * Notes API Service
 * Handles saving and loading daily notes
 */
class NotesService {
  /**
   * Save a note for a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {string} content - HTML content from Quill editor
   * @returns {Promise<Object>} - Saved note data
   */
  async saveNote(date, content) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/notes`, {
        date,
        content,
      });
      return response.data;
    } catch (error) {
      console.error('Error saving note:', error);
      
      // Network errors (connection refused, timeout, DNS failure)
      if (!error.response) {
        if (error.code === 'ECONNREFUSED' || error.message.includes('Network Error')) {
          throw new Error('Network error: Unable to connect to server. Please check your connection and ensure the backend server is running.');
        }
        if (error.code === 'ETIMEDOUT') {
          throw new Error('Network error: Request timed out. The server may be slow or unreachable.');
        }
        throw new Error('Network error: Failed to save note. Please check your internet connection.');
      }
      
      // HTTP status code errors
      const status = error.response.status;
      const serverError = error.response.data?.error || error.response.data?.message || 'Unknown server error';
      const details = error.response.data?.details || '';
      
      if (status === 400) {
        throw new Error(`Validation error: ${serverError}${details ? ` (${details})` : ''}`);
      }
      
      if (status === 404) {
        throw new Error(`Server error: Endpoint not found. Please verify the API is configured correctly.`);
      }
      
      if (status === 500) {
        const errorDetails = details ? ` Details: ${details}` : '';
        throw new Error(`Server error: ${serverError}${errorDetails}`);
      }
      
      // Other HTTP errors
      throw new Error(`Failed to save note (${status}): ${serverError}${details ? ` - ${details}` : ''}`);
    }
  }

  /**
   * Load a note for a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Promise<string|null>} - Note content or null if not found
   */
  async loadNote(date) {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/notes/${date}`);
      return response.data?.content || null;
    } catch (error) {
      if (error.response?.status === 404) {
        // No note exists for this date - return null
        return null;
      }
      console.error('Error loading note:', error);
      throw new Error(error.response?.data?.error || 'Failed to load note');
    }
  }

  /**
   * List all dates that have notes
   * @returns {Promise<string[]>} - Array of date strings in YYYY-MM-DD format, sorted descending (newest first)
   */
  async listAvailableDates() {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/notes`);
      return response.data?.dates || [];
    } catch (error) {
      console.error('Error listing available dates:', error);
      // Return empty array on error rather than throwing
      return [];
    }
  }

  /**
   * Save a calendar day note (separate from daily notes)
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {string} content - Text content for the calendar day
   * @returns {Promise<Object>} - Saved note data
   */
  async saveCalendarNote(date, content) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/notes/calendar`, {
        date,
        content,
      });
      return response.data;
    } catch (error) {
      console.error('Error saving calendar note:', error);
      
      // Network errors (connection refused, timeout, DNS failure)
      if (!error.response) {
        if (error.code === 'ECONNREFUSED' || error.message.includes('Network Error')) {
          throw new Error('Network error: Unable to connect to server. Please check your connection and ensure the backend server is running.');
        }
        if (error.code === 'ETIMEDOUT') {
          throw new Error('Network error: Request timed out. The server may be slow or unreachable.');
        }
        throw new Error('Network error: Failed to save calendar note. Please check your internet connection.');
      }
      
      // HTTP status code errors
      const status = error.response.status;
      const serverError = error.response.data?.error || error.response.data?.message || 'Unknown server error';
      const details = error.response.data?.details || '';
      
      if (status === 400) {
        throw new Error(`Validation error: ${serverError}${details ? ` (${details})` : ''}`);
      }
      
      if (status === 404) {
        throw new Error(`Server error: Endpoint not found. Please verify the API is configured correctly.`);
      }
      
      if (status === 500) {
        // Check if it's a DynamoDB table not found error
        if (details.includes('not found') || details.includes('does not exist')) {
          throw new Error(`Database error: CalendarNotes table not found. Please create the table in DynamoDB.`);
        }
        const errorDetails = details ? ` Details: ${details}` : '';
        throw new Error(`Server error: ${serverError}${errorDetails}`);
      }
      
      // Other HTTP errors
      throw new Error(`Failed to save calendar note (${status}): ${serverError}${details ? ` - ${details}` : ''}`);
    }
  }

  /**
   * Load a calendar day note
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Promise<string|null>} - Note content or null if not found
   */
  async loadCalendarNote(date) {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/notes/calendar/${date}`);
      return response.data?.content || null;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      console.error('Error loading calendar note:', error);
      throw new Error(error.response?.data?.error || 'Failed to load calendar note');
    }
  }
}

export const notesService = new NotesService();

