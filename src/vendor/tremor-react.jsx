import React from 'react';

function cx(...classes) {
  return classes.filter(Boolean).join(' ');
}

function styleWith(rest, style) {
  return { ...rest, style: { ...(rest.style || {}), ...style } };
}

export function Card({ children, className = '', decoration, decorationColor, ...rest }) {
  const borderStyle = decoration === 'top' && decorationColor
    ? { borderTop: `3px solid ${decorationColor}` }
    : null;
  return (
    <div className={cx('tremor-Card', className)} {...styleWith(rest, borderStyle)}>
      {children}
    </div>
  );
}

export function Text({ children, className = '', ...rest }) {
  return <p className={cx('tremor-Text', className)} {...rest}>{children}</p>;
}

export function Title({ children, className = '', ...rest }) {
  return <h3 className={cx('tremor-Title', className)} {...rest}>{children}</h3>;
}

export function Metric({ children, className = '', ...rest }) {
  return <div className={cx('tremor-Metric', className)} {...rest}>{children}</div>;
}

export function Button({ children, className = '', type = 'button', ...rest }) {
  return <button className={cx('tremor-Button', className)} type={type} {...rest}>{children}</button>;
}

export function TextInput({ className = '', ...rest }) {
  return <input className={cx('tremor-TextInput', className)} {...rest} />;
}

export function Badge({ children, className = '', color, ...rest }) {
  return (
    <span className={cx('tremor-Badge', color && `tremor-Badge-${color}`, className)} {...rest}>
      {children}
    </span>
  );
}

export function Flex({ children, className = '', justifyContent, alignItems, flexDirection, ...rest }) {
  const style = {
    display: 'flex',
    justifyContent,
    alignItems,
    flexDirection,
  };
  return <div className={cx('tremor-Flex', className)} {...styleWith(rest, style)}>{children}</div>;
}

export function Grid({ children, className = '', numItems, numItemsSm, numItemsLg, ...rest }) {
  const columns = numItemsLg || numItemsSm || numItems;
  const style = columns
    ? { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    : { display: 'grid' };
  return <div className={cx('tremor-Grid', className)} {...styleWith(rest, style)}>{children}</div>;
}

export function ProgressBar({ value = 0, className = '', color, ...rest }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={cx('tremor-ProgressBar', className)} {...rest}>
      <div
        className={cx('tremor-ProgressBar-fill', color && `tremor-ProgressBar-${color}`)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Table({ children, className = '', ...rest }) {
  return <table className={cx('tremor-Table', className)} {...rest}>{children}</table>;
}

export function TableHead({ children, className = '', ...rest }) {
  return <thead className={cx('tremor-TableHead', className)} {...rest}>{children}</thead>;
}

export function TableBody({ children, className = '', ...rest }) {
  return <tbody className={cx('tremor-TableBody', className)} {...rest}>{children}</tbody>;
}

export function TableRow({ children, className = '', ...rest }) {
  return <tr className={cx('tremor-TableRow', className)} {...rest}>{children}</tr>;
}

export function TableHeaderCell({ children, className = '', ...rest }) {
  return <th className={cx('tremor-TableHeaderCell', className)} {...rest}>{children}</th>;
}

export function TableCell({ children, className = '', ...rest }) {
  return <td className={cx('tremor-TableCell', className)} {...rest}>{children}</td>;
}
