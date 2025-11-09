import React, { useState, useEffect, useRef } from 'react';
import { Card, Text, Button } from '@tremor/react';

const TwitterFeed = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const scriptLoadedRef = useRef(false);
  const widgetLoadedRef = useRef(false);

  useEffect(() => {
    const loadTwitterWidget = () => {
      // Ensure the timeline element exists in DOM before loading
      if (!containerRef.current) {
        setError('Container element not found.');
        setLoading(false);
        return;
      }

      // Check if script already exists
      const existingScript = document.querySelector('script[src="https://platform.twitter.com/widgets.js"]');
      
      const initializeWidget = () => {
        // Check if timeline element exists
        const timelineLink = containerRef.current?.querySelector('a.twitter-timeline');
        if (!timelineLink) {
          // Element not ready yet, wait a bit
          setTimeout(() => {
            const retryLink = containerRef.current?.querySelector('a.twitter-timeline');
            if (!retryLink) {
              setError('Timeline element not found in container.');
              setLoading(false);
              return;
            }
            initializeWidget();
          }, 500);
          return;
        }

        // Use twttr.ready() to ensure API is fully initialized
        if (window.twttr && window.twttr.ready) {
          window.twttr.ready(() => {
            if (window.twttr.widgets && containerRef.current && !widgetLoadedRef.current) {
              // Let Twitter auto-detect first, then manually load if needed
              // Twitter's script should auto-detect, but we'll call load as backup
              setTimeout(() => {
                // Check if widget was already auto-detected and rendered
                const iframe = containerRef.current.querySelector('iframe');
                if (iframe) {
                  // Widget already loaded by auto-detection
                  setLoading(false);
                  widgetLoadedRef.current = true;
                } else {
                  // Manually trigger load
                  window.twttr.widgets.load(containerRef.current).then(() => {
                    setLoading(false);
                    widgetLoadedRef.current = true;
                  }).catch((err) => {
                    console.error('Error loading Twitter widget:', err);
                    setError('Failed to load Twitter feed. Make sure your list is public and accessible.');
                    setLoading(false);
                  });
                }
              }, 1000); // Give auto-detection time to work
            } else if (!window.twttr.widgets) {
              setError('Twitter widgets API not available.');
              setLoading(false);
            } else {
              setLoading(false);
            }
          });
        } else if (window.twttr && window.twttr.widgets) {
          // Fallback if ready() is not available
          if (containerRef.current && !widgetLoadedRef.current) {
            setTimeout(() => {
              const iframe = containerRef.current.querySelector('iframe');
              if (iframe) {
                setLoading(false);
                widgetLoadedRef.current = true;
              } else {
                window.twttr.widgets.load(containerRef.current).then(() => {
                  setLoading(false);
                  widgetLoadedRef.current = true;
                }).catch((err) => {
                  console.error('Error loading Twitter widget:', err);
                  setError('Failed to load Twitter feed. Make sure your list is public and accessible.');
                  setLoading(false);
                });
              }
            }, 1000);
          } else {
            setLoading(false);
          }
        } else {
          setError('Twitter widget script loaded but API not available.');
          setLoading(false);
        }
      };
      
      if (!existingScript && !scriptLoadedRef.current) {
        scriptLoadedRef.current = true;
        const script = document.createElement('script');
        script.src = 'https://platform.twitter.com/widgets.js';
        script.charset = 'utf-8';
        script.async = true;
        script.id = 'twitter-wjs';
        
        script.onload = () => {
          // Wait for Twitter to fully initialize and for DOM to be ready
          setTimeout(() => {
            initializeWidget();
          }, 1000);
        };
        
        script.onerror = () => {
          setError('Failed to load Twitter widget script.');
          setLoading(false);
        };
        
        document.body.appendChild(script);
      } else if (window.twttr) {
        // Script already loaded or loading
        if (window.twttr.ready) {
          // Wait a bit for DOM to be ready
          setTimeout(() => {
            initializeWidget();
          }, 500);
        } else {
          // Wait for script to fully load
          const checkInterval = setInterval(() => {
            if (window.twttr && window.twttr.ready) {
              clearInterval(checkInterval);
              setTimeout(() => {
                initializeWidget();
              }, 500);
            }
          }, 100);
          
          // Timeout after 10 seconds
          setTimeout(() => {
            clearInterval(checkInterval);
            setError('Twitter widget took too long to initialize.');
            setLoading(false);
          }, 10000);
        }
      } else if (existingScript) {
        // Script is loading, wait for it
        const checkInterval = setInterval(() => {
          if (window.twttr) {
            clearInterval(checkInterval);
            setTimeout(() => {
              initializeWidget();
            }, 500);
          }
        }, 100);
        
        // Timeout after 10 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          setError('Twitter widget took too long to load.');
          setLoading(false);
        }, 10000);
      }
    };

    // Delay to ensure DOM is fully rendered and element is visible
    const timer = setTimeout(() => {
      loadTwitterWidget();
    }, 300);

    return () => {
      clearTimeout(timer);
      // Reset widget loaded flag when component unmounts
      widgetLoadedRef.current = false;
    };
  }, []); // Empty deps - only run once on mount

  // Configuration - Update these with your Twitter username or list
  // Option 1: Show tweets from a specific user
  //   Set screenName to the username (without @)
  //
  // Option 2: Show tweets from a Twitter List (RECOMMENDED for multiple accounts)
  //   Create a Twitter List with the accounts you follow, then set:
  //   - listSlug: the slug/name of your list (e.g., "my-feed")
  //   - listOwner: your Twitter username (without @)
  //
  // Option 3: Show your home timeline (requires authentication - more complex)
  //   This would require Twitter API integration
  const twitterConfig = {
    // For a user timeline:
    screenName: '', // e.g., 'elonmusk' (without @)
    
    // For a list (RECOMMENDED - create a list of accounts you follow):
    listSlug: 'Hedgeye', // e.g., 'my-feed' or 'traders-i-follow'
    listOwner: 'smit2497', // Your Twitter username (without @)
    
    // For a list by ID (alternative to slug/owner):
    // listId: '', // Numeric list ID
    
    height: 600,
    theme: 'light', // 'light' or 'dark' - will respect dark mode
    chrome: 'noheader nofooter', // Remove header and footer for cleaner look
  };

  // Get theme from document
  const isDark = document.documentElement.classList.contains('dark');
  const theme = isDark ? 'dark' : 'light';

  return (
    <Card className="bg-gray-50 dark:bg-gray-800" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '12px' }}>
        <Text className="text-sm font-semibold dark:text-white mb-2">
          Twitter Feed
        </Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {twitterConfig.listSlug && twitterConfig.listOwner
            ? `Showing tweets from list: ${twitterConfig.listSlug}`
            : twitterConfig.screenName 
            ? `Showing tweets from @${twitterConfig.screenName}`
            : 'Configure your Twitter username or list in TwitterFeed.jsx'}
        </Text>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded text-xs text-yellow-700 dark:text-yellow-400">
          <Text className="font-semibold mb-1">⚠️ {error}</Text>
          <div className="text-xs">
            <div className="mb-1">Common issues:</div>
            <ul className="list-disc list-inside mt-1 ml-2">
              <li>Make sure your Twitter list is set to <strong>Public</strong> (not private)</li>
              <li>Verify the list name "Hedgeye" matches exactly (case-sensitive)</li>
              <li>Check that the list has members added to it</li>
              <li>Try refreshing the page</li>
            </ul>
          </div>
        </div>
      )}

      {loading && !error && (
        <div className="flex items-center justify-center" style={{ flex: 1, minHeight: '500px' }}>
          <Text className="text-gray-500 dark:text-gray-400">Loading Twitter feed...</Text>
        </div>
      )}

      <div 
        ref={containerRef}
        style={{ 
          flex: 1,
          minHeight: '500px',
          overflowY: 'auto',
          visibility: loading && !error ? 'hidden' : 'visible',
          opacity: loading && !error ? 0 : 1,
          transition: 'opacity 0.3s ease-in-out'
        }}
      >
        {twitterConfig.listSlug && twitterConfig.listOwner ? (
          // Twitter List timeline
          <a
            className="twitter-timeline"
            data-theme={theme}
            data-height={twitterConfig.height}
            data-chrome={twitterConfig.chrome}
            data-list-slug={twitterConfig.listSlug}
            data-list-owner={twitterConfig.listOwner}
            href={`https://x.com/${twitterConfig.listOwner}/lists/${twitterConfig.listSlug}?ref_src=twsrc%5Etfw`}
          >
            Tweets from {twitterConfig.listSlug}
          </a>
        ) : twitterConfig.listId ? (
          // Twitter List by ID
          <a
            className="twitter-timeline"
            data-theme={theme}
            data-height={twitterConfig.height}
            data-chrome={twitterConfig.chrome}
            data-list-id={twitterConfig.listId}
            href={`https://x.com/i/lists/${twitterConfig.listId}?ref_src=twsrc%5Etfw`}
          >
            Tweets from list
          </a>
        ) : twitterConfig.screenName ? (
          // User timeline
          <a
            className="twitter-timeline"
            data-theme={theme}
            data-height={twitterConfig.height}
            data-chrome={twitterConfig.chrome}
            href={`https://x.com/${twitterConfig.screenName}?ref_src=twsrc%5Etfw`}
          >
            Tweets by @{twitterConfig.screenName}
          </a>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center p-4 max-w-md">
              <Text className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                Twitter feed not configured
              </Text>
              <Text className="text-xs text-gray-600 dark:text-gray-400 mb-4">
                To show tweets from people you follow:
              </Text>
              <div className="text-left text-xs text-gray-600 dark:text-gray-400 space-y-2 bg-gray-100 dark:bg-gray-700 p-3 rounded">
                <div>
                  <strong>Option 1 (Recommended):</strong> Create a Twitter List with accounts you follow, then edit <code className="text-xs bg-gray-200 dark:bg-gray-600 px-1 rounded">TwitterFeed.jsx</code> and set:
                  <ul className="list-disc list-inside mt-1 ml-2">
                    <li><code>listSlug</code>: your list name</li>
                    <li><code>listOwner</code>: your Twitter username</li>
                  </ul>
                </div>
                <div>
                  <strong>Option 2:</strong> Show a specific user's timeline by setting <code className="text-xs bg-gray-200 dark:bg-gray-600 px-1 rounded">screenName</code>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};

export default TwitterFeed;

