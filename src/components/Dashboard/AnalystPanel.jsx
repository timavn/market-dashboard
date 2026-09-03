import React from 'react';
import AnalystConversationPanel from './AnalystConversationPanel';
import './AnalystPanel.css';

export {
  emphasizeHedgeyeViewLevels,
  normalizeAnalystPositionTables,
  omitRedundantPositionSections,
  splitAnalystFactText,
} from './analystMarkdown';

export class AnalystErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep Analyst failures inside this surface so the dashboard stays usable.
    console.error('[The Analyst] render failure', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <section
          className="analyst-panel analyst-panel--failed"
          role="alert"
          aria-label="The Analyst unavailable"
        >
          <div className="analyst-inline-error">
            <span>
              The Analyst view could not render. The rest of the dashboard is still available.
            </span>
            <button
              type="button"
              onClick={() => this.setState(({ resetKey }) => ({
                error: null,
                resetKey: resetKey + 1,
              }))}
            >
              Reload Analyst
            </button>
          </div>
        </section>
      );
    }
    return (
      <AnalystConversationPanel
        key={this.state.resetKey}
        {...this.props.panelProps}
      />
    );
  }
}

export default function AnalystPanel(props) {
  return <AnalystErrorBoundary panelProps={props} />;
}
