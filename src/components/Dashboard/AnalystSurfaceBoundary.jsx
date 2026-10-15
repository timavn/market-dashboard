import React from 'react';

/**
 * This boundary is intentionally loaded with PortfolioDashboard rather than with
 * the lazy Analyst chunk. That placement lets it contain both Analyst runtime
 * failures and a rejected Analyst chunk without unmounting the dashboard.
 */
export default class AnalystSurfaceBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[The Analyst] surface or chunk failure', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <section role="alert" aria-label="The Analyst unavailable">
          <div className="analyst-inline-error">
            <span>The Analyst could not load. The rest of the dashboard remains available.</span>
            {this.props.onClose && (
              <button type="button" onClick={this.props.onClose}>Close Analyst</button>
            )}
            <button type="button" onClick={() => window.location.reload()}>Reload dashboard</button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
