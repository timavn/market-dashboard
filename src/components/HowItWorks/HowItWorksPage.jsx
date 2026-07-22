import React, { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import {
  HOW_IT_WORKS_ARCHITECTURE,
  HOW_IT_WORKS_RELIABILITY,
  HOW_IT_WORKS_SECTIONS,
  HOW_IT_WORKS_TECH_STACK,
} from '../../constants/howItWorksContent';
import './HowItWorksPage.css';

const Field = ({ label, children, className = '' }) => (
  <div className={`hiw-field ${className}`.trim()}>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

const HermesBadge = ({ hermes }) => {
  const level = String(hermes?.level || 'None').toLowerCase();
  const tone = level.startsWith('direct') ? 'direct' : level === 'none' ? 'none' : 'indirect';
  return <span className={`hiw-hermes-badge is-${tone}`}>Hermes · {hermes?.level || 'None'}</span>;
};

const FeatureCard = ({ feature, index }) => (
  <article className="hiw-feature-card" id={feature.id} data-testid="how-it-works-feature">
    <div className="hiw-feature-card__topline">
      <span className="hiw-feature-number">{String(index + 1).padStart(2, '0')}</span>
      <div className="hiw-feature-badges">
        <span className="hiw-badge hiw-badge--status">{feature.status}</span>
        <span className="hiw-badge">{feature.dataMode}</span>
      </div>
    </div>
    <h3>{feature.title}</h3>
    <p className="hiw-feature-role">{feature.role}</p>

    <dl className="hiw-feature-details">
      <Field label="How it works">{feature.how}</Field>
      <Field label="Technology">
        <div className="hiw-chip-row">
          {feature.technology.map((item) => <span className="hiw-chip" key={item}>{item}</span>)}
        </div>
      </Field>
      <Field label="APIs & data sources">
        <ul>
          {feature.sources.map((source) => <li key={source}>{source}</li>)}
        </ul>
      </Field>
      <Field label="Math & methodology" className="hiw-field--formula">
        <code>{feature.math}</code>
      </Field>
      <Field label="Hermes role">
        <HermesBadge hermes={feature.hermes} />
        <p>{feature.hermes.detail}</p>
      </Field>
      <Field label="Freshness & failure behavior">{feature.freshness}</Field>
      <Field label="Why it matters" className="hiw-field--why">{feature.why}</Field>
    </dl>
  </article>
);

const HowItWorksPage = ({ onBack }) => {
  const { theme, toggleTheme } = useTheme();
  const [activeSection, setActiveSection] = useState(HOW_IT_WORKS_SECTIONS[0].id);
  const featureCount = useMemo(
    () => HOW_IT_WORKS_SECTIONS.reduce((sum, section) => sum + section.features.length, 0),
    [],
  );

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Dashboard System Guide | Market Dashboard';
    window.scrollTo?.(0, 0);
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const scrollToSection = (sectionId) => {
    setActiveSection(sectionId);
    const section = document.getElementById(sectionId);
    section?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    window.location.hash = '';
  };

  let featureOffset = 0;

  return (
    <main className="hiw-page" data-testid="how-it-works-page">
      <header className="hiw-topbar">
        <button type="button" className="hiw-topbar-button" onClick={handleBack}>
          <span aria-hidden="true">←</span> Dashboard
        </button>
        <span className="hiw-topbar-title">Dashboard System Guide / Technical Architecture</span>
        <button type="button" className="hiw-topbar-button hiw-theme-button" onClick={toggleTheme}>
          <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <section className="hiw-hero" aria-labelledby="hiw-title">
        <div className="hiw-hero__copy">
          <p className="hiw-kicker">Dashboard architecture · Technical system guide</p>
          <h1 id="hiw-title">Dashboard System Guide</h1>
          <p className="hiw-hero__lede">
            I built this system to turn live portfolio state, cross-asset markets, published research,
            and explicit quantitative models into one inspectable decision-support workflow.
          </p>
          <div className="hiw-hero__stats" aria-label="Project summary">
            <div><strong>{featureCount}</strong><span>documented surfaces</span></div>
            <div><strong>3</strong><span>data modes: live, snapshot, manual</span></div>
            <div><strong>0</strong><span>automatic orders</span></div>
          </div>
        </div>
        <aside className="hiw-hero__principle">
          <span>Core engineering rule</span>
          <strong>Verified live data—or an explicit unavailable state.</strong>
          <p>Models, snapshots, and portfolio positions never masquerade as executable quotes.</p>
        </aside>
      </section>

      <section className="hiw-overview" aria-labelledby="architecture-title">
        <div className="hiw-section-heading">
          <p className="hiw-kicker">Architecture</p>
          <h2 id="architecture-title">From source to decision</h2>
          <p>Each layer has a narrow responsibility and carries provenance forward.</p>
        </div>
        <div className="hiw-architecture" aria-label="System data flow">
          {HOW_IT_WORKS_ARCHITECTURE.map((item, index) => (
            <React.Fragment key={item.step}>
              <div className="hiw-architecture-step">
                <span>{item.step}</span>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
              </div>
              {index < HOW_IT_WORKS_ARCHITECTURE.length - 1 && <div className="hiw-architecture-arrow" aria-hidden="true">→</div>}
            </React.Fragment>
          ))}
        </div>
        <div className="hiw-stack" aria-label="Technology stack">
          {HOW_IT_WORKS_TECH_STACK.map((technology) => <span key={technology}>{technology}</span>)}
        </div>
      </section>

      <div className="hiw-mobile-nav">
        <label htmlFor="hiw-section-select">Jump to a section</label>
        <select
          id="hiw-section-select"
          value={activeSection}
          onChange={(event) => scrollToSection(event.target.value)}
        >
          {HOW_IT_WORKS_SECTIONS.map((section) => <option value={section.id} key={section.id}>{section.title}</option>)}
          <option value="reliability">Reliability & safety</option>
        </select>
      </div>

      <div className="hiw-layout">
        <nav className="hiw-toc" aria-label="How it works sections">
          <span className="hiw-toc__label">On this page</span>
          {HOW_IT_WORKS_SECTIONS.map((section) => (
            <button
              type="button"
              key={section.id}
              className={activeSection === section.id ? 'is-active' : ''}
              onClick={() => scrollToSection(section.id)}
            >
              <span>{section.eyebrow}</span>
              {section.title}
              <small>{section.features.length} surfaces</small>
            </button>
          ))}
          <button
            type="button"
            className={activeSection === 'reliability' ? 'is-active' : ''}
            onClick={() => scrollToSection('reliability')}
          >
            <span>Engineering policy</span>
            Reliability & safety
            <small>{HOW_IT_WORKS_RELIABILITY.length} principles</small>
          </button>
        </nav>

        <div className="hiw-content">
          {HOW_IT_WORKS_SECTIONS.map((section) => {
            const startingIndex = featureOffset;
            featureOffset += section.features.length;
            return (
              <section className="hiw-feature-section" id={section.id} key={section.id}>
                <div className="hiw-section-heading hiw-section-heading--numbered">
                  <span>{String(HOW_IT_WORKS_SECTIONS.indexOf(section) + 1).padStart(2, '0')}</span>
                  <div>
                    <p className="hiw-kicker">{section.eyebrow}</p>
                    <h2>{section.title}</h2>
                    <p>{section.summary}</p>
                  </div>
                </div>
                <div className="hiw-feature-grid">
                  {section.features.map((feature, index) => (
                    <FeatureCard feature={feature} index={startingIndex + index} key={feature.id} />
                  ))}
                </div>
              </section>
            );
          })}

          <section className="hiw-reliability" id="reliability">
            <div className="hiw-section-heading hiw-section-heading--numbered">
              <span>{String(HOW_IT_WORKS_SECTIONS.length + 1).padStart(2, '0')}</span>
              <div>
                <p className="hiw-kicker">Engineering policy</p>
                <h2>Reliability & safety</h2>
                <p>The application keeps source truth, model output, and executable data visibly separate.</p>
              </div>
            </div>
            <div className="hiw-reliability-grid">
              {HOW_IT_WORKS_RELIABILITY.map((item) => (
                <article key={item.title}>
                  <span aria-hidden="true">✓</span>
                  <div><h3>{item.title}</h3><p>{item.detail}</p></div>
                </article>
              ))}
            </div>
            <div className="hiw-safety-note">
              <strong>Public-safe by design.</strong>
              <span>This guide is static: it does not request quotes, positions, account data, or workflow status.</span>
            </div>
          </section>
        </div>
      </div>

      <footer className="hiw-footer">
        <div>
          <strong>Market Dashboard</strong>
          <span>Architecture, quantitative methods, and operational transparency.</span>
        </div>
        <button type="button" onClick={handleBack}>Return to dashboard <span aria-hidden="true">→</span></button>
      </footer>
    </main>
  );
};

export default HowItWorksPage;
