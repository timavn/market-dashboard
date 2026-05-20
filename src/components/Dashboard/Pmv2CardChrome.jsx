import React from 'react';

/**
 * Shared card chrome for Prediction Markets panels:
 * tinted header (icon + title + actions), optional tabs, scrollable body, optional footer.
 */
function Pmv2CardChrome({
  icon,
  title,
  titleId,
  actions,
  tabs,
  footer,
  className = '',
  bodyClassName = '',
  as: Tag = 'div',
  children,
}) {
  return (
    <Tag
      className={['pmv2-card-chrome', className].filter(Boolean).join(' ')}
      {...(titleId ? { 'aria-labelledby': titleId } : {})}
    >
      <div className="pmv2-card-chrome-header">
        <div className="pmv2-card-chrome-title-row">
          <div className="pmv2-card-chrome-title-left">
            {icon && (
              <span className="pmv2-card-chrome-icon" aria-hidden="true">
                {icon}
              </span>
            )}
            <h2 className="pmv2-card-chrome-title" id={titleId}>
              {title}
            </h2>
          </div>
          {actions && <div className="pmv2-card-chrome-actions">{actions}</div>}
        </div>
        {tabs && <div className="pmv2-card-chrome-tabs">{tabs}</div>}
      </div>
      <div className={['pmv2-card-chrome-body', bodyClassName].filter(Boolean).join(' ')}>
        {children}
      </div>
      {footer && <div className="pmv2-card-chrome-footer">{footer}</div>}
    </Tag>
  );
}

export default Pmv2CardChrome;
