import React from 'react';

export default class SurfaceErrorBoundary extends React.Component {
  state = { error: null, retry: 0 };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('[Dashboard panel] Unable to render', error);
  }

  render() {
    if (this.state.error) {
      return (
        <section role="alert" aria-label="Panel unavailable" className="p-4 space-y-3">
          <p>This panel could not load. You can continue using the dashboard.</p>
          <button type="button" onClick={() => this.setState(({ retry }) => ({ error: null, retry: retry + 1 }))}>
            Retry panel
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload dashboard
          </button>
        </section>
      );
    }
    return <React.Fragment key={this.state.retry}>{this.props.children}</React.Fragment>;
  }
}
