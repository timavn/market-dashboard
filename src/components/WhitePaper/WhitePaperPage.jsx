import React from 'react';
import ProcessPage from '../Process/ProcessPage';

/**
 * Compatibility wrapper for imports that predate the Process document system.
 * The public `#/white-paper` URL redirects to the master paper in App.jsx.
 */
const WhitePaperPage = (props) => (
  <ProcessPage {...props} documentId="position-sizing" />
);

export default WhitePaperPage;
