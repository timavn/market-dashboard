import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Card, Text, Button } from '@tremor/react';
import LoadingIndicator from '../common/LoadingIndicator';

const TwitterFeed = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const scriptLoadedRef = useRef(false);
  const widgetLoadedRef = useRef(false);
  const initializingRef = useRef(false); // Guard to prevent double initialization

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
  const twitterConfig = useMemo(() => ({
    // For a user timeline:
    screenName: '', // e.g., 'elonmusk' (without @)
    
    // For a list by ID (RECOMMENDED - most reliable):
    listId: '1986465259113357401', // Numeric list ID from https://x.com/i/lists/{id}
    
    // For a list by slug/owner (alternative to ID):
    // listSlug: 'Hedgeye', // e.g., 'my-feed' or 'traders-i-follow'
    // listOwner: 'smit2497', // Your Twitter username (without @)
    
    height: 600,
    theme: 'light', // 'light' or 'dark' - will respect dark mode
    chrome: 'noheader nofooter', // Remove header and footer for cleaner look
  }), []); // Memoize to prevent recreation on every render

  useEffect(() => {
    // Log configuration for debugging
    const listUrl = twitterConfig.listId
      ? `https://x.com/i/lists/${twitterConfig.listId}`
      : twitterConfig.listSlug && twitterConfig.listOwner 
      ? `https://x.com/${twitterConfig.listOwner}/lists/${twitterConfig.listSlug}`
      : twitterConfig.screenName
      ? `https://x.com/${twitterConfig.screenName}`
      : 'Not configured';
    
    console.log('[TwitterFeed] Initializing Twitter widget...');
    console.log('[TwitterFeed] Configuration:', {
      listId: twitterConfig.listId,
      listSlug: twitterConfig.listSlug,
      listOwner: twitterConfig.listOwner,
      screenName: twitterConfig.screenName,
      listUrl: listUrl
    });
    
    // Ensure the timeline element exists in DOM before loading
    if (!containerRef.current) {
      console.error('[TwitterFeed] Container element not found');
      setError('Container element not found.');
      setLoading(false);
      return;
    }

    // Check if timeline element exists
    const timelineLink = containerRef.current?.querySelector('a.twitter-timeline');
    if (!timelineLink) {
      console.error('[TwitterFeed] Timeline element not found in container');
      setError('Timeline element not found in container.');
      setLoading(false);
      return;
    }
    console.log('[TwitterFeed] Timeline element found:', timelineLink);
    console.log('[TwitterFeed] Timeline element href:', timelineLink.href);
    console.log('[TwitterFeed] Timeline element data attributes:', {
      listSlug: timelineLink.getAttribute('data-list-slug'),
      listOwner: timelineLink.getAttribute('data-list-owner'),
      listId: timelineLink.getAttribute('data-list-id'),
      screenName: timelineLink.getAttribute('data-screen-name')
    });

    // Check if script already exists
    const existingScript = document.querySelector('script[src="https://platform.twitter.com/widgets.js"]');
    
    const initializeWidget = () => {
      // Prevent double initialization
      if (initializingRef.current || widgetLoadedRef.current) {
        console.log('[TwitterFeed] Widget initialization already in progress or completed, skipping...');
        return;
      }
      
      initializingRef.current = true;
      console.log('[TwitterFeed] Initializing widget...');
      
      // Check if timeline element still exists
      const timelineLink = containerRef.current?.querySelector('a.twitter-timeline');
      if (!timelineLink) {
        console.error('[TwitterFeed] Timeline element disappeared');
        setError('Timeline element not found in container.');
        setLoading(false);
        initializingRef.current = false;
        return;
      }

      // Check if Twitter API is available
      if (!window.twttr) {
        console.error('[TwitterFeed] window.twttr not available');
        setError('Twitter widget script not loaded.');
        setLoading(false);
        initializingRef.current = false;
        return;
      }

      console.log('[TwitterFeed] Twitter API available, widgets:', !!window.twttr.widgets);

      // Use twttr.ready() callback - it's a function, not a property
      if (typeof window.twttr.ready === 'function') {
        console.log('[TwitterFeed] Using twttr.ready() callback');
        window.twttr.ready(() => {
          console.log('[TwitterFeed] Twitter API ready, widgets available:', !!window.twttr.widgets);
          
          if (!window.twttr.widgets) {
            console.error('[TwitterFeed] Twitter widgets API not available');
            setError('Twitter widgets API not available.');
            setLoading(false);
            initializingRef.current = false;
            return;
          }

          if (!containerRef.current || widgetLoadedRef.current) {
            console.log('[TwitterFeed] Widget already loaded or container missing');
            setLoading(false);
            initializingRef.current = false;
            return;
          }

          // Let Twitter auto-detect first (it scans for .twitter-timeline elements)
          // Wait a bit for auto-detection to work
          setTimeout(() => {
            // Check for iframes even if hidden - check both container and document
            const containerIframes = containerRef.current?.querySelectorAll('iframe') || [];
            const allDocumentIframes = document.querySelectorAll('iframe');
            const allIframes = Array.from(new Set([...containerIframes, ...allDocumentIframes]));
            
            const twitterIframes = allIframes.filter(iframe => 
              iframe.src && (iframe.src.includes('twitter.com') || iframe.src.includes('x.com'))
            );
            
            // Look for timeline iframe - prioritize ones in container, then check all
            const timelineIframe = twitterIframes.find(iframe => 
              (iframe.src.includes('list') || iframe.src.includes('timeline') || 
               iframe.src.includes(twitterConfig.listId || '')) &&
              containerRef.current?.contains(iframe)
            ) || twitterIframes.find(iframe => 
              iframe.src.includes('list') || iframe.src.includes('timeline') || 
              iframe.src.includes(twitterConfig.listId || '')
            ) || twitterIframes[0];
            
            if (timelineIframe) {
              const computedStyle = window.getComputedStyle(timelineIframe);
              const isHidden = computedStyle.display === 'none' || computedStyle.visibility === 'hidden';
              
              // If iframe is outside container, move it in (Twitter sometimes creates it at body level)
              if (!containerRef.current?.contains(timelineIframe)) {
                console.log('[TwitterFeed] Timeline iframe found outside container, moving into container...');
                containerRef.current?.appendChild(timelineIframe);
              }
              
              // Hide the original <a> tag if it still exists (Twitter should replace it, but sometimes doesn't)
              const timelineLink = containerRef.current?.querySelector('a.twitter-timeline');
              if (timelineLink) {
                console.log('[TwitterFeed] Hiding original <a> tag since iframe is ready');
                timelineLink.style.display = 'none';
                timelineLink.style.visibility = 'hidden';
              }
              
              if (isHidden) {
                console.log('[TwitterFeed] Widget auto-detected but is hidden, forcing visibility...');
                timelineIframe.style.display = 'block';
                timelineIframe.style.visibility = 'visible';
                
                // Set proper dimensions if they're too small
                if (computedStyle.width === '300px' || computedStyle.height === '150px') {
                  console.log('[TwitterFeed] Iframe has small dimensions, setting proper size...');
                  timelineIframe.style.width = '100%';
                  timelineIframe.style.height = `${twitterConfig.height || 600}px`;
                  timelineIframe.style.minHeight = '500px';
                }
                
                // Also check and fix parent styles
                let parent = timelineIframe.parentElement;
                while (parent && parent !== document.body) {
                  const parentStyle = window.getComputedStyle(parent);
                  if (parentStyle.display === 'none') {
                    parent.style.display = 'block';
                  }
                  if (parentStyle.height === '0px' || parentStyle.height === 'auto') {
                    parent.style.height = 'auto';
                    parent.style.minHeight = `${twitterConfig.height || 600}px`;
                  }
                  parent = parent.parentElement;
                }
              }
              
              console.log('[TwitterFeed] Widget auto-detected and rendered successfully');
              setLoading(false);
              widgetLoadedRef.current = true;
              initializingRef.current = false;
            } else {
              console.log('[TwitterFeed] Auto-detection failed, manually loading widget...');
              // Manually trigger load
              window.twttr.widgets.load(containerRef.current).then((result) => {
                console.log('[TwitterFeed] Widget load promise resolved:', result);
                
                // Check if iframe actually rendered - also check for other elements Twitter might create
                // IMPORTANT: Check for iframes even if they're hidden (display: none)
                const checkIframe = (attempt = 1, maxAttempts = 10) => {
                  // First, check if the <a> tag still exists (meaning Twitter hasn't replaced it yet)
                  const timelineLink = containerRef.current?.querySelector('a.twitter-timeline');
                  const linkStillExists = !!timelineLink;
                  
                  // Look for ALL iframes, not just visible ones
                  const allIframes = containerRef.current?.querySelectorAll('iframe') || [];
                  const twitterIframes = Array.from(allIframes).filter(iframe => 
                    iframe.src && (iframe.src.includes('twitter.com') || iframe.src.includes('x.com'))
                  );
                  
                  // Also check for iframes in the document that might be related
                  const documentIframes = document.querySelectorAll('iframe');
                  const allTwitterIframes = Array.from(documentIframes).filter(iframe => 
                    iframe.src && (iframe.src.includes('twitter.com') || iframe.src.includes('x.com'))
                  );
                  
                  // Log what we find
                  if (attempt === 1) {
                    console.log('[TwitterFeed] Checking for iframes:', {
                      linkStillExists: linkStillExists,
                      iframesInContainer: allIframes.length,
                      twitterIframesInContainer: twitterIframes.length,
                      allTwitterIframesInDocument: allTwitterIframes.length,
                      containerHTML: containerRef.current?.innerHTML?.substring(0, 200)
                    });
                    
                    // If link still exists, Twitter hasn't processed it yet
                    if (linkStillExists) {
                      console.log('[TwitterFeed] <a> tag still exists - Twitter may not have processed it yet');
                      console.log('[TwitterFeed] Link element:', {
                        href: timelineLink.href,
                        className: timelineLink.className,
                        dataAttributes: {
                          listId: timelineLink.getAttribute('data-list-id'),
                          theme: timelineLink.getAttribute('data-theme'),
                          height: timelineLink.getAttribute('data-height')
                        }
                      });
                    }
                    
                    // Log details of found iframes
                    if (twitterIframes.length > 0) {
                      twitterIframes.forEach((iframe, idx) => {
                        const computedStyle = window.getComputedStyle(iframe);
                        console.log(`[TwitterFeed] Found Twitter iframe ${idx + 1}:`, {
                          src: iframe.src.substring(0, 100),
                          display: computedStyle.display,
                          visibility: computedStyle.visibility,
                          inlineStyle: iframe.style.cssText,
                          width: computedStyle.width,
                          height: computedStyle.height,
                          inContainer: containerRef.current?.contains(iframe)
                        });
                      });
                    }
                  }
                  
                  // Check for timeline iframe (not just settings/analytics iframes)
                  // Timeline iframes typically have the list ID or timeline in the src
                  // IMPORTANT: Exclude settings and analytics iframes (they have specific patterns)
                  const timelineIframe = twitterIframes.find(iframe => {
                    const src = iframe.src.toLowerCase();
                    // Exclude settings and analytics iframes
                    const isSettings = src.includes('widget_iframe') && !src.includes('timeline');
                    const isAnalytics = src.includes('rufous') || iframe.id === 'rufous-sandbox';
                    // Look for actual timeline iframes - they usually have 'timeline' or 'embed' in the src
                    const isTimeline = src.includes('timeline') || 
                                      src.includes('embed') || 
                                      src.includes('list') ||
                                      src.includes(twitterConfig.listId || '');
                    return !isSettings && !isAnalytics && isTimeline;
                  }) || twitterIframes.find(iframe => {
                    // Fallback: any iframe that's not settings/analytics
                    const src = iframe.src.toLowerCase();
                    return !src.includes('widget_iframe') && 
                           !src.includes('rufous') && 
                           iframe.id !== 'rufous-sandbox';
                  }) || twitterIframes[0]; // Last resort: first Twitter iframe
                  
                  if (timelineIframe) {
                    // If iframe is outside container, move it in (Twitter sometimes creates it at body level)
                    if (!containerRef.current?.contains(timelineIframe)) {
                      console.log('[TwitterFeed] Timeline iframe found outside container, moving into container...');
                      containerRef.current?.appendChild(timelineIframe);
                    }
                    
                    // Hide the original <a> tag if it still exists (Twitter should replace it, but sometimes doesn't)
                    const timelineLink = containerRef.current?.querySelector('a.twitter-timeline');
                    if (timelineLink) {
                      console.log('[TwitterFeed] Hiding original <a> tag since iframe is ready');
                      timelineLink.style.display = 'none';
                      timelineLink.style.visibility = 'hidden';
                      timelineLink.style.position = 'absolute';
                      timelineLink.style.opacity = '0';
                      timelineLink.style.pointerEvents = 'none';
                    }
                    
                    const computedStyle = window.getComputedStyle(timelineIframe);
                    const isHidden = computedStyle.display === 'none' || 
                                    computedStyle.visibility === 'hidden' ||
                                    timelineIframe.style.display === 'none';
                    
                    console.log(`[TwitterFeed] Found timeline iframe (attempt ${attempt}):`, {
                      src: timelineIframe.src,
                      display: computedStyle.display,
                      visibility: computedStyle.visibility,
                      isHidden: isHidden,
                      width: computedStyle.width,
                      height: computedStyle.height,
                      inContainer: containerRef.current?.contains(timelineIframe),
                      id: timelineIframe.id,
                      className: timelineIframe.className,
                      title: timelineIframe.title
                    });
                    
                    // Check if this is actually a timeline iframe or just settings/analytics
                    const srcLower = timelineIframe.src.toLowerCase();
                    const isLikelyTimeline = srcLower.includes('timeline') || 
                                            srcLower.includes('embed') ||
                                            srcLower.includes('syndication');
                    if (!isLikelyTimeline) {
                      console.warn('[TwitterFeed] WARNING: Found iframe may not be the timeline iframe:', {
                        src: timelineIframe.src,
                        isSettings: srcLower.includes('widget_iframe'),
                        isAnalytics: srcLower.includes('rufous') || timelineIframe.id === 'rufous-sandbox'
                      });
                    }
                    
                    // Always set proper dimensions - Twitter sometimes creates iframes that are too small
                    const needsSizeFix = computedStyle.width === '300px' || 
                                        computedStyle.height === '150px' ||
                                        parseInt(computedStyle.width) < 400 ||
                                        parseInt(computedStyle.height) < 400;
                    
                    if (needsSizeFix) {
                      console.log('[TwitterFeed] Iframe has small dimensions, setting proper size...');
                      timelineIframe.style.width = '100%';
                      timelineIframe.style.height = `${twitterConfig.height || 600}px`;
                      timelineIframe.style.minHeight = '500px';
                      timelineIframe.style.minWidth = '100%';
                    }
                    
                    // Check parent container for hiding styles
                    let parent = timelineIframe.parentElement;
                    let parentHiding = false;
                    while (parent && parent !== document.body) {
                      const parentStyle = window.getComputedStyle(parent);
                      if (parentStyle.display === 'none' || 
                          parentStyle.visibility === 'hidden' ||
                          parentStyle.height === '0px' ||
                          (parentStyle.overflow === 'hidden' && parentStyle.height === 'auto')) {
                        parentHiding = true;
                        console.warn('[TwitterFeed] Parent element may be hiding iframe:', {
                          tagName: parent.tagName,
                          className: parent.className,
                          display: parentStyle.display,
                          visibility: parentStyle.visibility,
                          height: parentStyle.height,
                          overflow: parentStyle.overflow
                        });
                        break;
                      }
                      parent = parent.parentElement;
                    }
                    
                    // Force visibility if hidden
                    if (isHidden || parentHiding) {
                      console.log('[TwitterFeed] Iframe is hidden, forcing visibility...');
                      timelineIframe.style.display = 'block';
                      timelineIframe.style.visibility = 'visible';
                      
                      // Also ensure parent is visible
                      if (parentHiding && parent) {
                        parent.style.display = 'block';
                        parent.style.visibility = 'visible';
                        if (parent.style.height === '0px' || !parent.style.height) {
                          parent.style.height = 'auto';
                          parent.style.minHeight = `${twitterConfig.height || 600}px`;
                        }
                      }
                      
                      // Ensure container is visible
                      if (containerRef.current) {
                        const containerStyle = window.getComputedStyle(containerRef.current);
                        if (containerStyle.display === 'none' || containerStyle.visibility === 'hidden') {
                          containerRef.current.style.display = 'flex';
                          containerRef.current.style.visibility = 'visible';
                        }
                      }
                      
                      console.log('[TwitterFeed] Iframe visibility forced, checking again...');
                      // Wait a moment for styles to apply, then check again
                      setTimeout(() => {
                        const newStyle = window.getComputedStyle(timelineIframe);
                        console.log('[TwitterFeed] Iframe style after forcing:', {
                          display: newStyle.display,
                          visibility: newStyle.visibility,
                          width: newStyle.width,
                          height: newStyle.height
                        });
                        if (newStyle.display !== 'none' && newStyle.visibility !== 'hidden') {
                          console.log('[TwitterFeed] Widget iframe is now visible!');
                          setLoading(false);
                          widgetLoadedRef.current = true;
                          initializingRef.current = false;
                        } else {
                          console.warn('[TwitterFeed] Iframe still hidden after forcing visibility');
                        }
                      }, 200);
                    } else {
                      console.log('[TwitterFeed] Widget iframe is visible and rendered successfully');
                      setLoading(false);
                      widgetLoadedRef.current = true;
                      initializingRef.current = false;
                    }
                  } else if (linkStillExists && attempt < maxAttempts) {
                    // Link still exists - Twitter hasn't replaced it yet, wait longer
                    console.log(`[TwitterFeed] <a> tag still exists, Twitter processing... (attempt ${attempt}/${maxAttempts})`);
                    
                    // If we've waited a while and Twitter still hasn't created the iframe, try creating it manually
                    if (attempt >= 5) {
                      console.log('[TwitterFeed] Twitter not creating iframe, attempting to create manually...');
                      const timelineLink = containerRef.current?.querySelector('a.twitter-timeline');
                      if (timelineLink) {
                        // Get the list ID from the link
                        const listId = timelineLink.getAttribute('data-list-id');
                        if (listId) {
                          // Create iframe manually using Twitter's list embed URL
                          // Note: Twitter's embed system is complex, this is a fallback
                          const manualIframe = document.createElement('iframe');
                          // Use Twitter's embed URL format for lists
                          const embedUrl = `https://platform.twitter.com/embed/Timelines.html?dnt=false&embedId=twitter-widget-0&frame=false&hideCard=false&hideThread=false&lang=en&theme=light&widgetsVersion=2615f7e52b7e0%3A1702314776716&width=550px&listId=${listId}`;
                          manualIframe.src = embedUrl;
                          manualIframe.width = '100%';
                          manualIframe.height = `${twitterConfig.height || 600}px`;
                          manualIframe.frameBorder = '0';
                          manualIframe.scrolling = 'no';
                          manualIframe.allowTransparency = 'true';
                          manualIframe.style.border = 'none';
                          manualIframe.style.overflow = 'hidden';
                          manualIframe.style.display = 'block';
                          manualIframe.style.visibility = 'visible';
                          manualIframe.id = 'twitter-timeline-manual';
                          manualIframe.title = 'Twitter Timeline';
                          
                          // Hide the link and add the iframe
                          timelineLink.style.display = 'none';
                          timelineLink.style.visibility = 'hidden';
                          timelineLink.style.position = 'absolute';
                          timelineLink.style.opacity = '0';
                          timelineLink.style.pointerEvents = 'none';
                          containerRef.current?.appendChild(manualIframe);
                          console.log('[TwitterFeed] Manually created timeline iframe with URL:', embedUrl);
                          
                          // Mark as loaded
                          setLoading(false);
                          widgetLoadedRef.current = true;
                          initializingRef.current = false;
                          return;
                        }
                      }
                    }
                    
                    setTimeout(() => checkIframe(attempt + 1, maxAttempts), 1000); // Wait longer for Twitter to process
                  } else if (attempt < maxAttempts) {
                    console.log(`[TwitterFeed] Timeline iframe not found yet, retrying... (attempt ${attempt}/${maxAttempts})`);
                    setTimeout(() => checkIframe(attempt + 1, maxAttempts), 500);
                  } else {
                    console.error('[TwitterFeed] Widget load promise resolved but no timeline iframe found after all retries');
                    console.error('[TwitterFeed] Found iframes:', {
                      total: allIframes.length,
                      twitter: twitterIframes.length,
                      allTwitter: allTwitterIframes.length,
                      linkStillExists: linkStillExists
                    });
                    console.error('[TwitterFeed] Container contents:', containerRef.current?.innerHTML);
                    console.error('[TwitterFeed] Container children:', Array.from(containerRef.current?.children || []).map(c => ({
                      tagName: c.tagName,
                      className: c.className,
                      id: c.id,
                      innerHTML: c.innerHTML?.substring(0, 100)
                    })));
                    const listUrl = twitterConfig.listId
                      ? `https://x.com/i/lists/${twitterConfig.listId}`
                      : twitterConfig.listSlug && twitterConfig.listOwner 
                      ? `https://x.com/${twitterConfig.listOwner}/lists/${twitterConfig.listSlug}`
                      : 'N/A';
                    
                    let errorMsg = '';
                    if (linkStillExists) {
                      errorMsg = `Twitter widget script loaded but did not replace the link with an iframe. The <a> tag is still present after ${maxAttempts * 1000}ms. This may indicate Twitter's embed API is not processing list embeds, or there's an issue with the list configuration. List URL: ${listUrl}. Try: (1) Verify the list is public and accessible, (2) Check if Twitter list embeds work on other sites, (3) Consider using a user timeline instead.`;
                    } else {
                      errorMsg = `Twitter widget loaded but timeline iframe not found after ${maxAttempts * 500}ms. Found ${twitterIframes.length} Twitter iframe(s) but none appear to be the timeline. List URL: ${listUrl}. Check browser console for iframe details.`;
                    }
                    setError(errorMsg);
                    setLoading(false);
                    initializingRef.current = false;
                  }
                };
                
                // Check for network errors first - wait a moment for requests to complete
                setTimeout(() => {
                  const checkNetworkErrors = () => {
                    const performanceEntries = performance.getEntriesByType('resource');
                    const twitterRequests = performanceEntries.filter(entry => 
                      (entry.name.includes('twitter.com') || entry.name.includes('x.com')) &&
                      (entry.name.includes('widget') || entry.name.includes('timeline'))
                    );
                    
                    // Check for critical widget files that must load
                    const criticalFiles = twitterRequests.filter(entry => 
                      entry.name.includes('widget_iframe') || entry.name.includes('timeline.js')
                    );
                    
                    // Check for actual failures - cached responses (transferSize: 0) are valid
                    // Only flag as failed if: very short duration (< 50ms) AND zero size AND no decoded body
                    // This indicates a blocked/failed request, not a cached one
                    const failedCritical = criticalFiles.filter(entry => {
                      // Cached responses can have transferSize: 0 but decodedBodySize > 0
                      // Failed requests have both zero AND very short duration
                      const isLikelyFailed = entry.transferSize === 0 && 
                                           entry.decodedBodySize === 0 && 
                                           entry.duration < 50;
                      return isLikelyFailed;
                    });
                    
                    if (failedCritical.length > 0) {
                      console.error('[TwitterFeed] Critical Twitter widget files failed to load:', failedCritical.map(r => r.name));
                      const listUrl = twitterConfig.listId
                        ? `https://x.com/i/lists/${twitterConfig.listId}`
                        : twitterConfig.listSlug && twitterConfig.listOwner 
                        ? `https://x.com/${twitterConfig.listOwner}/lists/${twitterConfig.listSlug}`
                        : 'N/A';
                      const failedFiles = failedCritical.map(r => {
                        const fileName = r.name.split('/').pop().split('?')[0];
                        return fileName;
                      }).join(', ');
                      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
                      const errorMsg = isLocalhost 
                        ? `Twitter widget cannot load because required files are being blocked: ${failedFiles}. This may be caused by: (1) Browser extensions blocking Twitter (check chrome://extensions/), (2) Chrome's privacy/security settings, or (3) Twitter blocking localhost origins. Try: Disable extensions, test in incognito mode, or deploy to a real domain. List URL: ${listUrl}`
                        : `Twitter widget cannot load because required files are being blocked: ${failedFiles}. This is likely caused by privacy extensions (ad blockers) or browser security settings blocking Twitter requests. Check chrome://extensions/ for extensions, or try incognito mode. List URL: ${listUrl}`;
                      setError(errorMsg);
                      setLoading(false);
                      initializingRef.current = false;
                      return true; // Indicate error detected
                    }
                    
                    console.log('[TwitterFeed] Twitter widget network requests:', criticalFiles.map(r => ({
                      url: r.name.split('/').pop().split('?')[0],
                      duration: r.duration,
                      transferSize: r.transferSize,
                      decodedBodySize: r.decodedBodySize,
                      status: (r.transferSize > 0 || r.decodedBodySize > 0) ? 'OK (may be cached)' : 'CHECKING...'
                    })));
                    return false; // No errors detected
                  };
                  
                  const hasNetworkErrors = checkNetworkErrors();
                  if (!hasNetworkErrors) {
                    // Continue with iframe check if no network errors
                    checkIframe();
                  }
                }, 1000); // Wait 1 second for network requests to complete
              }).catch((err) => {
                console.error('[TwitterFeed] Error loading Twitter widget:', err);
                console.error('[TwitterFeed] Error details:', {
                  message: err?.message,
                  stack: err?.stack,
                  name: err?.name
                });
                const listUrl = twitterConfig.listId
                  ? `https://x.com/i/lists/${twitterConfig.listId}`
                  : twitterConfig.listSlug && twitterConfig.listOwner 
                  ? `https://x.com/${twitterConfig.listOwner}/lists/${twitterConfig.listSlug}`
                  : 'N/A';
                setError(`Failed to load Twitter feed. Error: ${err?.message || 'Unknown error'}. List URL: ${listUrl}. Check browser Network tab for blocked requests.`);
                setLoading(false);
                initializingRef.current = false;
              });
            }
          }, 1500); // Give auto-detection time to work
        });
      } else if (window.twttr.widgets) {
        // Fallback if ready() is not available (shouldn't happen, but just in case)
        console.log('[TwitterFeed] twttr.ready() not available, using widgets directly');
        if (containerRef.current && !widgetLoadedRef.current) {
          setTimeout(() => {
            const iframe = containerRef.current?.querySelector('iframe');
            if (iframe) {
              console.log('[TwitterFeed] Widget already rendered');
              setLoading(false);
              widgetLoadedRef.current = true;
            } else {
              console.log('[TwitterFeed] Manually loading widget (fallback)...');
              window.twttr.widgets.load(containerRef.current).then(() => {
                setTimeout(() => {
                  const iframe = containerRef.current?.querySelector('iframe');
                  if (iframe) {
                    console.log('[TwitterFeed] Widget loaded successfully (fallback)');
                    setLoading(false);
                    widgetLoadedRef.current = true;
                  } else {
                    console.error('[TwitterFeed] Widget load failed (fallback)');
                    setError('Twitter widget loaded but failed to render.');
                    setLoading(false);
                  }
                }, 500);
              }).catch((err) => {
                console.error('[TwitterFeed] Error loading Twitter widget (fallback):', err);
                setError('Failed to load Twitter feed. Make sure your list is public and accessible.');
                setLoading(false);
              });
            }
          }, 1000);
        } else {
          setLoading(false);
        }
      } else {
        console.error('[TwitterFeed] Twitter widgets API not available');
        setError('Twitter widget script loaded but widgets API not available.');
        setLoading(false);
      }
    };
    
    // Load script if it doesn't exist
    if (!existingScript && !scriptLoadedRef.current) {
      console.log('[TwitterFeed] Loading Twitter widgets.js script...');
      scriptLoadedRef.current = true;
      const script = document.createElement('script');
      script.src = 'https://platform.twitter.com/widgets.js';
      script.charset = 'utf-8';
      script.async = true;
      script.id = 'twitter-wjs';
      
      script.onload = () => {
        console.log('[TwitterFeed] Twitter widgets.js script loaded');
        // Wait a moment for Twitter to initialize, then initialize widget
        setTimeout(() => {
          initializeWidget();
        }, 500);
      };
      
      script.onerror = () => {
        console.error('[TwitterFeed] Failed to load Twitter widget script');
        setError('Failed to load Twitter widget script.');
        setLoading(false);
      };
      
      document.body.appendChild(script);
    } else if (window.twttr) {
      // Script already loaded
      console.log('[TwitterFeed] Twitter script already loaded, initializing widget...');
      if (typeof window.twttr.ready === 'function') {
        window.twttr.ready(() => {
          initializeWidget();
        });
      } else {
        // If ready() is not available, try direct initialization
        setTimeout(() => {
          initializeWidget();
        }, 500);
      }
    } else if (existingScript) {
      // Script is loading, wait for it
      console.log('[TwitterFeed] Twitter script is loading, waiting...');
      const checkInterval = setInterval(() => {
        if (window.twttr) {
          console.log('[TwitterFeed] Twitter script finished loading');
          clearInterval(checkInterval);
          if (typeof window.twttr.ready === 'function') {
            window.twttr.ready(() => {
              initializeWidget();
            });
          } else {
            setTimeout(() => {
              initializeWidget();
            }, 500);
          }
        }
      }, 100);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        if (!window.twttr) {
          console.error('[TwitterFeed] Twitter widget took too long to load');
          setError('Twitter widget took too long to load.');
          setLoading(false);
        }
      }, 10000);
    } else {
      console.error('[TwitterFeed] No script found and unable to load');
      setError('Unable to load Twitter widget script.');
      setLoading(false);
    }

    return () => {
      // Reset widget loaded flag when component unmounts
      console.log('[TwitterFeed] Component unmounting, resetting flags');
      widgetLoadedRef.current = false;
      initializingRef.current = false;
    };
  }, []); // Empty deps - config is static, only run once on mount

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
          {twitterConfig.listId
            ? `Showing tweets from list ID: ${twitterConfig.listId}`
            : twitterConfig.listSlug && twitterConfig.listOwner
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
            <div className="mb-1">Troubleshooting steps:</div>
            <ul className="list-disc list-inside mt-1 ml-2 space-y-1">
              <li><strong>Privacy Extensions:</strong> Disable ad blockers, privacy extensions (uBlock Origin, Privacy Badger, etc.) - they may block Twitter embeds. Twitter shows a warning if extensions interfere.</li>
              <li><strong>Check Network tab:</strong> Open browser DevTools → Network tab → Look for failed requests to <code>platform.twitter.com</code> or <code>syndication.twitter.com</code></li>
              <li><strong>Verify list URL:</strong> Visit {twitterConfig.listId ? `https://x.com/i/lists/${twitterConfig.listId}` : twitterConfig.listSlug && twitterConfig.listOwner ? `https://x.com/${twitterConfig.listOwner}/lists/${twitterConfig.listSlug}` : 'the list URL'} directly to confirm it's accessible</li>
              <li><strong>List settings:</strong> Make sure your Twitter list is set to <strong>Public</strong> (not private)</li>
              <li><strong>Browser console:</strong> Check for CORS errors or security policy blocks in the console</li>
              <li>Try refreshing the page</li>
            </ul>
          </div>
        </div>
      )}

      {loading && !error && (
        <div className="flex items-center justify-center" style={{ flex: 1, minHeight: '500px' }}>
          <LoadingIndicator label="Loading Twitter feed…" />
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
        {twitterConfig.listId ? (
          // Twitter List by ID (RECOMMENDED - most reliable)
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
        ) : twitterConfig.listSlug && twitterConfig.listOwner ? (
          // Twitter List timeline by slug/owner
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

