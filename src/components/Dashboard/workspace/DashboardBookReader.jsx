import React from 'react';
import PersistentSurface from '../../common/PersistentSurface';
import { Text, Button, Title } from '@tremor/react';
import { Suspense } from 'react';

export default function DashboardBookReader({
  showBookModal,
  selectedBookContent,
  setShowBookModal,
  theme,
  selectedTag,
  tagSectionsMap,
  setSelectedTag,
  scrollToSection,
  selectedBookTitle,
  tags,
  tagCounts,
  bookContentRef,
  LazyPanelFallback,
  ReactMarkdown,
  sections
}) {
  return (
    <PersistentSurface
        manageFocus
          active={showBookModal && Boolean(selectedBookContent)}
          className="dashboard-book-reader-host"
          onClick={() => {
            setShowBookModal(false);
          }}
        >
          <div
            className="dashboard-book-reader-dialog"
            role="dialog"
            aria-label={selectedBookTitle || 'Research notes'}
            style={{
              '--dashboard-book-width': selectedTag ? '1400px' : '1200px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Left Sidebar - Tag Navigation */}
            {selectedTag && tagSectionsMap[selectedTag] && (
              <div
                style={{
                  width: '250px',
                  borderRight: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  transition: 'width 0.3s ease-in-out',
                }}
              >
                {/* Sidebar Header */}
                <div
                  style={{
                    padding: '16px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      margin: 0,
                    }}
                  >
                    #{selectedTag}
                  </Text>
                  <Button
                    onClick={() => setSelectedTag(null)}
                    variant="secondary"
                    size="sm"
                    style={{ minWidth: '24px', height: '24px', padding: '0', fontSize: '14px' }}
                  >
                    ✕
                  </Button>
                </div>

                {/* Sections List */}
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '8px',
                  }}
                >
                  {tagSectionsMap[selectedTag].map((section, index) => (
                    <div
                      key={section.id}
                      onClick={() => scrollToSection(section.id)}
                      style={{
                        padding: '12px',
                        marginBottom: '8px',
                        borderRadius: '0.375rem',
                        cursor: 'pointer',
                        backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
                        border: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                        transition: 'all 0.2s ease-in-out',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                        e.currentTarget.style.borderColor = theme === 'dark' ? '#4b5563' : '#d1d5db';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                        e.currentTarget.style.borderColor = theme === 'dark' ? '#374151' : '#e5e7eb';
                      }}
                    >
                      <div
                        style={{
                          fontSize: section.level === 2 ? '14px' : '13px',
                          fontWeight: section.level === 2 ? 600 : 500,
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          marginBottom: '4px',
                        }}
                      >
                        {section.title}
                      </div>
                      {section.snippet && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: theme === 'dark' ? '#9ca3af' : '#6b7280',
                            lineHeight: '1.4',
                            marginTop: '4px',
                          }}
                        >
                          {section.snippet}...
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Main Content Area */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0, // Allow flexbox to shrink
                minHeight: 0,
              }}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '20px',
                  borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Title
                  style={{
                    fontSize: '24px',
                    fontWeight: 700,
                    margin: 0,
                    color: theme === 'dark' ? '#f3f4f6' : '#000',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                  }}
                >
                  {selectedBookTitle}
                </Title>
                <Button
                  onClick={() => {
                    setShowBookModal(false);
                  }}
                  variant="secondary"
                  size="sm"
                  style={{ minWidth: '32px', height: '32px', padding: '0' }}
                >
                  ✕
                </Button>
              </div>

              {/* Tag Bar */}
              {tags.length > 0 && (
                <div
                  style={{
                    padding: '12px 20px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px',
                    backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  }}
                >
                  {tags.map((tag) => {
                    const count = tagCounts[tag] || 0;
                    const isActive = selectedTag === tag;
                    return (
                      <button
                        key={tag}
                        onClick={() => setSelectedTag(isActive ? null : tag)}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          fontWeight: 500,
                          borderRadius: '0.375rem',
                          border: `1px solid ${isActive
                            ? (theme === 'dark' ? '#3b82f6' : '#c7d2fe')
                            : (theme === 'dark' ? '#374151' : '#e5e7eb')
                            }`,
                          backgroundColor: isActive
                            ? (theme === 'dark' ? '#1e3a8a' : '#f3f4f6')
                            : (theme === 'dark' ? '#1f2937' : '#ffffff'),
                          color: isActive
                            ? (theme === 'dark' ? '#93c5fd' : '#111')
                            : (theme === 'dark' ? '#f3f4f6' : '#111'),
                          cursor: 'pointer',
                          transition: 'all 0.2s ease-in-out',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                            e.currentTarget.style.borderColor = theme === 'dark' ? '#4b5563' : '#d1d5db';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                            e.currentTarget.style.borderColor = theme === 'dark' ? '#374151' : '#e5e7eb';
                          }
                        }}
                      >
                        <span>#{tag}</span>
                        <span
                          style={{
                            fontSize: '10px',
                            opacity: 0.7,
                            padding: '2px 6px',
                            borderRadius: '0.25rem',
                            backgroundColor: isActive
                              ? (theme === 'dark' ? 'rgba(147, 197, 253, 0.2)' : 'rgba(30, 64, 175, 0.2)')
                              : (theme === 'dark' ? 'rgba(156, 163, 175, 0.2)' : 'rgba(107, 114, 128, 0.2)'),
                          }}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Modal Content */}
              <div
                ref={bookContentRef}
                style={{
                  padding: '24px',
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                  flex: 1,
                  color: theme === 'dark' ? '#f3f4f6' : '#111',
                  lineHeight: '1.6',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
              >
                <Suspense fallback={<LazyPanelFallback label="Loading notes..." />}>
                  <ReactMarkdown
                    components={{
                    h2: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 2);
                      return (
                        <h2
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.5rem',
                            fontWeight: 700,
                            marginTop: '2rem',
                            marginBottom: '1rem',
                            borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                            paddingBottom: '0.5rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#000',
                          }}
                          {...props}
                        >
                          {children}
                        </h2>
                      );
                    },
                    h3: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 3);
                      return (
                        <h3
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.25rem',
                            fontWeight: 600,
                            marginTop: '1.5rem',
                            marginBottom: '0.75rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          }}
                          {...props}
                        >
                          {children}
                        </h3>
                      );
                    },
                    h4: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 4);
                      return (
                        <h4
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.1rem',
                            fontWeight: 600,
                            marginTop: '1.25rem',
                            marginBottom: '0.75rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          }}
                          {...props}
                        >
                          {children}
                        </h4>
                      );
                    },
                    p: ({ node, children, ...props }) => (
                      <p
                        style={{
                          marginBottom: '1rem',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        }}
                        {...props}
                      >
                        {children}
                      </p>
                    ),
                    strong: ({ node, children, ...props }) => (
                      <strong style={{ fontWeight: 700 }} {...props}>
                        {children}
                      </strong>
                    ),
                    em: ({ node, children, ...props }) => (
                      <em style={{ fontStyle: 'italic' }} {...props}>
                        {children}
                      </em>
                    ),
                    hr: ({ node, ...props }) => (
                      <hr
                        style={{
                          margin: '1.5rem 0',
                          border: 'none',
                          borderTop: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                        }}
                        {...props}
                      />
                    ),
                    ul: ({ node, children, ...props }) => (
                      <ul
                        style={{
                          marginBottom: '1rem',
                          paddingLeft: '1.5rem',
                          listStyleType: 'disc',
                        }}
                        {...props}
                      >
                        {children}
                      </ul>
                    ),
                    ol: ({ node, children, ...props }) => (
                      <ol
                        style={{
                          marginBottom: '1rem',
                          paddingLeft: '1.5rem',
                          listStyleType: 'decimal',
                        }}
                        {...props}
                      >
                        {children}
                      </ol>
                    ),
                    li: ({ node, children, ...props }) => (
                      <li
                        style={{
                          marginBottom: '0.5rem',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        }}
                        {...props}
                      >
                        {children}
                      </li>
                    ),
                    }}
                  >
                    {selectedBookContent}
                  </ReactMarkdown>
                </Suspense>
              </div>
            </div>

            {/* Right Sidebar - Table of Contents */}
            {sections.length > 0 && (
              <div
                style={{
                  width: '220px',
                  borderLeft: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  transition: 'width 0.3s ease-in-out',
                }}
              >
                {/* TOC Header */}
                <div
                  style={{
                    padding: '16px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  }}
                >
                  <Text
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      margin: 0,
                    }}
                  >
                    Table of Contents
                  </Text>
                </div>

                {/* TOC List */}
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '12px 8px',
                  }}
                >
                  {sections.map((section, index) => {
                    const indent = section.level === 2 ? 0 : section.level === 3 ? 16 : 32;
                    return (
                      <div
                        key={section.id}
                        onClick={() => scrollToSection(section.id)}
                        style={{
                          padding: '8px 12px',
                          paddingLeft: `${12 + indent}px`,
                          marginBottom: '4px',
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                          backgroundColor: 'transparent',
                          transition: 'all 0.2s ease-in-out',
                          fontSize: section.level === 2 ? '13px' : section.level === 3 ? '12px' : '11px',
                          fontWeight: section.level === 2 ? 600 : section.level === 3 ? 500 : 400,
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          borderLeft: section.level === 2
                            ? `2px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`
                            : 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }}
                      >
                        {section.title}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
      </PersistentSurface>
  );
}
