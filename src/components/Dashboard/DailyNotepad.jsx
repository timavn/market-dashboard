import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Text, Button } from '@tremor/react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { notesService } from '../../services/api/notesService';
import MarketCalendar from './MarketCalendar';

const DailyNotepad = () => {
  const [viewMode, setViewMode] = useState('notes'); // 'notes' or 'calendar'
  // Get today's date in YYYY-MM-DD format for default
  const getTodayDateKey = () => new Date().toISOString().split('T')[0];
  
  const [selectedDate, setSelectedDate] = useState(getTodayDateKey());
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // 'saved' or 'error'
  const [saveError, setSaveError] = useState(null);
  const debounceTimerRef = useRef(null);
  const quillRef = useRef(null);

  // Format date for display (e.g., "November 5, 2025")
  const formatDateForDisplay = (dateKey) => {
    const date = new Date(dateKey + 'T00:00:00'); // Add time to avoid timezone issues
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  // Load note when selectedDate changes
  useEffect(() => {
    const loadNote = async () => {
      try {
        setLoading(true);
        setContent(''); // Clear content when switching dates
        const noteContent = await notesService.loadNote(selectedDate);
        if (noteContent) {
          setContent(noteContent);
        } else {
          setContent(''); // No note exists for this date
        }
      } catch (error) {
        console.error('Failed to load note:', error);
        setContent('');
      } finally {
        setLoading(false);
      }
    };

    loadNote();
  }, [selectedDate]);

  // Auto-save with debounce
  const saveNote = useCallback(async (noteContent) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(async () => {
      try {
        setSaving(true);
        setSaveStatus(null);
        await notesService.saveNote(selectedDate, noteContent);
        setSaveStatus('saved');
        setSaveError(null); // Clear any previous errors
        // Clear save status after 2 seconds
        setTimeout(() => setSaveStatus(null), 2000);
      } catch (error) {
        console.error('Failed to save note:', error);
        setSaveStatus('error');
        setSaveError(error.message || 'Failed to save note');
        // Clear error message after 5 seconds
        setTimeout(() => setSaveError(null), 5000);
      } finally {
        setSaving(false);
      }
    }, 2000); // Save 2 seconds after user stops typing
  }, [selectedDate]);

  // Handle date change - save current note before switching
  const handleDateChange = async (e) => {
    const newDate = e.target.value;
    if (newDate && newDate !== selectedDate) {
      // Clear any pending debounced save
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      
      // Immediately save current content to old date if there's content
      // Check if content has actual text (strip HTML tags)
      const textContent = content.replace(/<[^>]*>/g, '').trim();
      if (textContent !== '') {
        try {
          await notesService.saveNote(selectedDate, content);
        } catch (error) {
          console.error('Failed to save note before date change:', error);
        }
      }
      
      // Switch to new date
      setSelectedDate(newDate);
    }
  };

  // Handle content change
  const handleChange = (value) => {
    setContent(value);
    setSaveError(null); // Clear error when user starts typing
    saveNote(value);
  };

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Setup image paste handler after Quill is initialized
  useEffect(() => {
    if (!loading && quillRef.current) {
      const quill = quillRef.current.getEditor();
      const editor = quill.root;

      const handlePaste = (e) => {
        const clipboardData = e.clipboardData || window.clipboardData;
        const items = clipboardData.items;

        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            e.preventDefault();
            e.stopPropagation();
            const blob = items[i].getAsFile();
            const reader = new FileReader();

            reader.onload = (event) => {
              const base64Image = event.target.result;
              const range = quill.getSelection(true);
              if (range) {
                quill.insertEmbed(range.index, 'image', base64Image, 'user');
                quill.setSelection(range.index + 1);
              }
            };

            reader.readAsDataURL(blob);
            return false;
          }
        }
      };

      editor.addEventListener('paste', handlePaste);
      return () => {
        if (editor) {
          editor.removeEventListener('paste', handlePaste);
        }
      };
    }
  }, [loading]); // Re-run when editor finishes loading

  const modules = {
    toolbar: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      ['link', 'image'],
      [{ 'color': [] }, { 'background': [] }],
      ['clean']
    ],
    clipboard: {
      // Enable image paste
      matchVisual: false,
    },
  };

  const formats = [
    'header',
    'bold', 'italic', 'underline', 'strike',
    'list', 'bullet',
    'link', 'image',
    'color', 'background'
  ];

  return (
    <Card className="bg-gray-50 dark:bg-gray-800" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        {/* Toggle buttons */}
        <div style={{ display: 'flex', gap: '4px', marginRight: '8px' }}>
          <Button
            size="xs"
            variant={viewMode === 'notes' ? 'primary' : 'secondary'}
            onClick={() => setViewMode('notes')}
            className={viewMode === 'notes' 
              ? 'dark:bg-blue-600 dark:text-white' 
              : 'dark:bg-gray-700 dark:text-gray-300'
            }
          >
            Daily Notes
          </Button>
          <Button
            size="xs"
            variant={viewMode === 'calendar' ? 'primary' : 'secondary'}
            onClick={() => setViewMode('calendar')}
            className={viewMode === 'calendar' 
              ? 'dark:bg-blue-600 dark:text-white' 
              : 'dark:bg-gray-700 dark:text-gray-300'
            }
          >
            Market Calendar
          </Button>
        </div>
        
        {viewMode === 'notes' && (
          <>
            <Text className="text-sm font-semibold dark:text-white">
              Daily Notes:
            </Text>
            <input
              type="date"
              value={selectedDate}
              onChange={handleDateChange}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              style={{
                cursor: 'pointer',
              }}
            />
            <Text className="text-sm font-medium dark:text-gray-300">
              {formatDateForDisplay(selectedDate)}
            </Text>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
              {saveStatus === 'saved' && (
                <Text className="text-xs text-green-600 dark:text-green-400">
                  Saved
                </Text>
              )}
              {saveStatus === 'error' && (
                <Text className="text-xs text-red-600 dark:text-red-400" title={saveError || 'Save failed'}>
                  Save failed
                </Text>
              )}
              {saving && (
                <Text className="text-xs text-gray-500 dark:text-gray-400">
                  Saving...
                </Text>
              )}
            </div>
          </>
        )}
      </div>

      {/* Error message display for Daily Notes */}
      {viewMode === 'notes' && saveError && (
        <div className="mb-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">
          {saveError}
        </div>
      )}

      {viewMode === 'calendar' ? (
        <MarketCalendar />
      ) : (
        <>
          {loading ? (
            <div className="flex items-center justify-center" style={{ flex: 1, minHeight: '500px' }}>
              <Text className="text-gray-500 dark:text-gray-400">Loading...</Text>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-700 rounded" style={{ 
              borderRadius: '4px',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: '500px'
            }}>
              <ReactQuill
                ref={quillRef}
                theme="snow"
                value={content}
                onChange={handleChange}
                modules={modules}
                formats={formats}
                placeholder="An open text box here for writing notes throughout the day, copy pasting things, maybe able to put snipped images here. I just want a clean text box interface with basic but effective tooling."
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              />
              <style>{`
                /* Date input styling */
                input[type="date"]::-webkit-calendar-picker-indicator {
                  cursor: pointer;
                  filter: invert(0.5);
                }
                .dark input[type="date"]::-webkit-calendar-picker-indicator {
                  filter: invert(0.8);
                }
                input[type="date"]::-webkit-inner-spin-button,
                input[type="date"]::-webkit-outer-spin-button {
                  -webkit-appearance: none;
                  margin: 0;
                }
                
                .ql-container {
                  flex: 1;
                  display: flex;
                  flex-direction: column;
                  border-bottom-left-radius: 4px;
                  border-bottom-right-radius: 4px;
                  border-color: #e5e7eb;
                }
                .ql-editor {
                  flex: 1;
                  min-height: 500px;
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
                  font-size: 14px;
                  line-height: 1.6;
                  color: #1f2937;
                }
                .dark .ql-editor {
                  color: #f3f4f6;
                }
                .ql-editor img {
                  max-width: 100%;
                  height: auto;
                  border-radius: 4px;
                  margin: 8px 0;
                  display: block;
                }
                .dark .ql-container {
                  border-color: #4b5563;
                }
                .ql-toolbar {
                  border-top-left-radius: 4px;
                  border-top-right-radius: 4px;
                  background-color: #ffffff;
                  border-color: #e5e7eb;
                }
                .dark .ql-toolbar {
                  background-color: #374151;
                  border-color: #4b5563;
                }
                .dark .ql-stroke {
                  stroke: #f3f4f6;
                }
                .dark .ql-fill {
                  fill: #f3f4f6;
                }
                .ql-editor.ql-blank::before {
                  font-style: normal;
                  color: #9ca3af;
                }
                .dark .ql-editor.ql-blank::before {
                  color: #6b7280;
                }
              `}</style>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

export default DailyNotepad;

