import React from 'react';
import { Card, Title, Text } from '@tremor/react';

const WelcomeToTheMachine = () => {
  // Machine-style colors - black/gray theme with tech accents
  const machineColor = '#000000'; // Black for primary text
  const machineGray = '#4B5563'; // Medium gray for secondary text
  const machineAccent = '#1F2937'; // Dark gray accent

  return (
    <Card className="bg-white dark:bg-gray-800">
      {/* Header section at top */}
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: '10px', // Reduced from 20px
        paddingBottom: '10px', // Reduced from 20px
        borderBottom: '2px solid #60A5FA', // Horizontal blue bar
      }}>
        <div
          style={{
            fontFamily: "'Share Tech Mono', 'Courier New', 'Monaco', monospace", // More robotic monospace font
            fontWeight: 900,
            fontSize: 'clamp(2rem, 8vw, 6rem)',
            letterSpacing: '0.15em', // Increased for more mechanical feel
            textTransform: 'uppercase',
            textShadow: '2px 2px 4px rgba(0,0,0,0.1)',
            textAlign: 'center',
            lineHeight: 1.1, // Reduced from 1.2 for tighter spacing
          }}
          className="tracking-wider select-none dark:text-gray-200"
        >
          {/* Line 1: Welcome */}
          <div style={{ 
            color: machineColor,
            marginBottom: '0.1em' // Reduced from 0.2em
          }}>Welcome</div>
          
          {/* Line 2: To The */}
          <div style={{ 
            color: machineColor, // Changed from machineGray to black
            fontSize: '0.85em',
            fontWeight: 700,
            marginBottom: '0.1em' // Reduced from 0.2em
          }}>To The</div>
          
          {/* Line 3: Machine */}
          <div style={{ 
            color: machineColor,
          }}>Machine</div>
        </div>
      </div>

      {/* Content area below header */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px', minHeight: '300px' }}> {/* Reduced from 400px */}
        <Title className="mb-4 dark:text-white" style={{ 
          fontFamily: "'Orbitron', 'Rajdhani', sans-serif",
          fontWeight: 700,
          letterSpacing: '0.05em'
        }}>Welcome to the Machine</Title>
        <div className="space-y-4">
          <Text className="text-sm text-gray-600 dark:text-gray-400">
            Template content area - ready for customization.
          </Text>
          {/* Placeholder for future content */}
          <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg border-2 border-gray-200 dark:border-gray-600" style={{
            fontFamily: "'Share Tech Mono', 'Courier New', monospace",
          }}>
            <Text className="text-xs text-gray-500 dark:text-gray-400">
              Add your content here...
            </Text>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default WelcomeToTheMachine;

