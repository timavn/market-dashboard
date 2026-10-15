import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import GlobalQuadsCard, { previewQuarters, QuadsPreview } from './GlobalQuadsCard';
const id='a'.repeat(64);
const snapshot={data:{sources:{[id]:{id,asOf:'2026-08-27',sourceUrl:'https://mail.google.com/mail/#all/abc',imageUrl:'/api/hedgeye/global-quads/source/a'}},groups:{g20:{asOf:'2026-08-27',sourceId:id,currentCountries:['United States'],columns:[{id:'2026-Q3',label:'3Q26E',kind:'estimate'},{id:'2026-Q4',label:'4Q26E',kind:'estimate'},{id:'2027-Q1',label:'1Q27E',kind:'estimate'}],rows:[{country:'United States',values:{'2026-Q3':{quad:4,kind:'estimate',sourceId:id}}}]}}}};
test('quarter preview crosses a year boundary',()=>{
  const group={columns:[
    {id:'2026-Q2'}, {id:'2026-Q3'}, {id:'2026-Q4'}, {id:'2027-Q1'}, {id:'2027-Q2'}, {id:'2027-Q3'},
  ]};
  expect(previewQuarters(group,new Date('2027-01-01T12:00:00Z')).map(c=>c.label)).toEqual(['4Q26','1Q27','2Q27E','3Q27E','4Q27E']);
});
test('preview shows previous, current, and three future quarters while retaining publication provenance',()=>{
  const group={columns:[
    {id:'2025-Q4',label:'4Q25',kind:'actual'},
    {id:'2026-Q1',label:'1Q26',kind:'actual'},
    {id:'2026-Q2',label:'2Q26E',kind:'estimate'},
    ...snapshot.data.groups.g20.columns,
  ]};
  const columns=previewQuarters(group,new Date('2026-09-09T12:00:00Z'));
  expect(columns.map(c=>c.label)).toEqual(['2Q26','3Q26','4Q26E','1Q27E','2Q27E']);
  expect(columns.map(c=>c.period)).toEqual(['previous','current','estimate','estimate','estimate']);
  expect(columns[0].kind).toBe('estimate');
  expect(columns[1].kind).toBe('estimate');
  expect(group.columns.find(c=>c.id==='2026-Q3').label).toBe('3Q26E');
  expect(previewQuarters({columns:group.columns.filter(c=>c.id!=='2026-Q4')},new Date('2026-09-09T12:00:00Z'))).toHaveLength(5);
});
test.each([
  ['2026-10-01T03:59:59Z', ['2Q26','3Q26','4Q26E','1Q27E','2Q27E']],
  ['2026-10-01T04:00:00Z', ['3Q26','4Q26','1Q27E','2Q27E','3Q27E']],
])('preview rolls forward at the New York quarter boundary: %s', (now, labels) => {
  expect(previewQuarters(snapshot.data.groups.g20, new Date(now)).map(c=>c.label)).toEqual(labels);
});
test('readings are read-only and estimates remain estimates after quarter end',()=>{
  localStorage.setItem('quadForecast_v3','{"United States":{"3Q26E":"1"}}');
  render(<GlobalQuadsCard resourceState={{data:snapshot}}/>);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByText('4')).toHaveAttribute('title',expect.stringContaining('Estimate'));
  expect(screen.getByRole('link',{name:'Email'})).toHaveAttribute('href','https://mail.google.com/mail/#all/abc');
  expect(localStorage.getItem('quadForecast_v3')).toBe('{"United States":{"3Q26E":"1"}}');
});
test('renders explicit unavailable without falling back to manual values',()=>{
  render(<QuadsPreview snapshot={{data:{groups:{},sources:{}}}}/>);expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
});

describe('expanded country preview', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-12T12:00:00Z')));
  afterEach(() => jest.useRealTimers());

  const previewSnapshot = () => {
    const reviewed = JSON.parse(JSON.stringify(snapshot));
    const group = reviewed.data.groups.g20;
    group.currentCountries = ['MODE/MEDIAN', 'United States', 'China', 'Germany', 'Japan', 'United Kingdom', 'Canada', 'India', 'South Korea', 'Australia', 'Brazil', 'France', 'Mexico'];
    group.rows = group.currentCountries.map(country => ({
      country,
      aggregate: country === 'MODE/MEDIAN',
      values: { '2026-Q3': { quad: country === 'Canada' ? 2 : 3, kind: 'estimate', sourceId: id } },
    }));
    return reviewed;
  };

  test('renders five ordered quarters with a current label and leaves unpublished estimates blank', () => {
    const reviewed = previewSnapshot();
    reviewed.data.groups.g20.rows.find(row => row.country === 'United States').values['2026-Q4'] = { quad: 2, kind: 'estimate', sourceId: id };
    render(<QuadsPreview snapshot={reviewed} />);
    const table = screen.getByRole('table', { name: 'G20 quad preview' });
    expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual([
      'Market', '2Q26', '3Q26', '4Q26E', '1Q27E', '2Q27E',
    ]);
    expect(within(table).getByRole('columnheader', { name: '2Q26' })).toHaveAttribute('title', 'Previous quarter');
    expect(within(table).getByRole('columnheader', { name: '3Q26' })).toHaveAttribute('title', 'Current quarter');
    const cells = within(within(table).getByRole('row', { name: /United States/ })).getAllByRole('cell');
    expect(cells.map(cell => cell.textContent)).toEqual(['—', '3', '2', '—', '—']);
    expect(within(cells[4]).queryByRole('link')).not.toBeInTheDocument();
  });

  test('fills the preview with eleven sourced rows while preserving the original eight', () => {
    render(<QuadsPreview snapshot={previewSnapshot()} />);
    const table = screen.getByRole('table', { name: 'G20 quad preview' });
    expect(within(table).getAllByRole('rowheader').map(row => row.textContent)).toEqual([
      'G20 mode/median', 'United States', 'China', 'Germany', 'Japan', 'United Kingdom', 'Canada', 'India',
      'South Korea', 'Australia', 'Brazil',
    ]);
    const canada = within(table).getByRole('row', { name: /Canada/ });
    expect(within(canada).getByRole('link', { name: '2' })).toHaveAttribute('title', expect.stringContaining('Estimate'));
    expect(within(canada).getByRole('link', { name: '2' })).toHaveAttribute('href', expect.stringContaining('/api/hedgeye/global-quads/source/a'));
    expect(within(table).getByRole('row', { name: /India/ })).toHaveTextContent('3');
    ['South Korea', 'Australia', 'Brazil'].forEach(country => {
      const row = within(table).getByRole('row', { name: new RegExp(country) });
      expect(within(row).getByRole('link', { name: '3' })).toHaveAttribute('title', 'Hedgeye · As of Aug 27, 2026 · Estimate');
      expect(within(row).getByRole('link', { name: '3' })).toHaveAttribute('href', expect.stringContaining('/api/hedgeye/global-quads/source/a'));
    });
  });

  test('omits countries outside the current publication and withholds unsourced readings', () => {
    const reviewed = previewSnapshot();
    reviewed.data.groups.g20.currentCountries = reviewed.data.groups.g20.currentCountries.filter(country => country !== 'Canada');
    reviewed.data.groups.g20.rows.find(row => row.country === 'India').values['2026-Q3'].sourceId = 'missing';
    render(<QuadsPreview snapshot={reviewed} />);
    expect(screen.queryByRole('rowheader', { name: 'Canada' })).not.toBeInTheDocument();
    const india = screen.getByRole('row', { name: /India/ });
    expect(within(india).queryByRole('link')).not.toBeInTheDocument();
    expect(within(india).getAllByRole('cell').every(cell => cell.textContent === '—')).toBe(true);
  });

  test('never fills missing added countries or provenance with an invented reading', () => {
    const reviewed = previewSnapshot();
    reviewed.data.groups.g20.currentCountries = reviewed.data.groups.g20.currentCountries.filter(country => country !== 'Australia');
    reviewed.data.groups.g20.rows.find(row => row.country === 'Brazil').values['2026-Q3'].sourceId = 'missing';
    render(<QuadsPreview snapshot={reviewed} />);
    expect(screen.queryByRole('rowheader', { name: 'Australia' })).not.toBeInTheDocument();
    const brazil = screen.getByRole('row', { name: /Brazil/ });
    expect(within(brazil).queryByRole('link')).not.toBeInTheDocument();
    expect(within(brazil).getAllByRole('cell').every(cell => cell.textContent === '—')).toBe(true);
  });
});

test('opens the complete country table by default without filtering to the compact selection',()=>{
  const reviewed=JSON.parse(JSON.stringify(snapshot));reviewed.data.sources[id].sourceUrl=null;
  reviewed.data.groups.global={...reviewed.data.groups.g20,rows:[
    ...['Austria','Singapore','United States'].map(country=>({country,values:{'2026-Q3':{quad:4,kind:'estimate',sourceId:id}}})),
    {country:'MODE/MEAN',aggregate:true,values:{'2026-Q3':{quad:4,kind:'estimate',sourceId:id}}},
  ]};
  render(<GlobalQuadsCard resourceState={{data:reviewed}}/>);
  expect(screen.getByRole('tab',{name:'All countries'})).toHaveAttribute('aria-selected','true');
  const panel=screen.getByRole('tabpanel',{name:'All countries'});
  expect(within(panel).getAllByRole('rowheader').map(row=>row.textContent)).toEqual(['Austria','Singapore','United States','MODE/MEAN']);
  expect(screen.getByText('MODE/MEAN')).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Email'})).not.toBeInTheDocument();
  expect(screen.getAllByRole('link',{name:'Source chart'})).toHaveLength(1);
});

test('switches tables with the keyboard, preserving each source and unavailable group',()=>{
  const reviewed=JSON.parse(JSON.stringify(snapshot));
  const globalId='b'.repeat(64);
  reviewed.data.sources[globalId]={id:globalId,asOf:'2026-08-12',imageUrl:'/global-source'};
  reviewed.data.groups.global={...reviewed.data.groups.g20,sourceId:globalId,asOf:'2026-08-12',rows:[{country:'MODE/MEAN',aggregate:true,values:{'2026-Q3':{quad:3,kind:'estimate',sourceId:globalId}}}]};
  render(<GlobalQuadsCard resourceState={{data:reviewed}}/>);
  fireEvent.keyDown(screen.getByRole('tab',{name:'G20'}),{key:'ArrowRight'});
  expect(screen.getByRole('tab',{name:'Emerging markets'})).toHaveFocus();
  expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Source chart'})).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('tab',{name:'Emerging markets'}),{key:'Home'});
  expect(screen.getByRole('tab',{name:'All countries'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByRole('link',{name:'Source chart'})).toHaveAttribute('href',expect.stringContaining('/global-source'));
  expect(screen.getByText('As of Aug 12, 2026')).toBeInTheDocument();
  expect(within(screen.getByRole('tabpanel')).getAllByRole('table')).toHaveLength(1);
});

test('keeps all sourced quarters and separates actuals from estimates',()=>{
  const reviewed=JSON.parse(JSON.stringify(snapshot));
  reviewed.data.groups.g20.columns.unshift({id:'2026-Q2',label:'2Q26',kind:'actual'});
  reviewed.data.groups.g20.rows[0].values['2026-Q2']={quad:1,kind:'actual',sourceId:id};
  render(<GlobalQuadsCard resourceState={{data:reviewed}}/>);
  expect(screen.getByRole('columnheader',{name:'Actuals'})).toHaveAttribute('colspan','1');
  expect(screen.getByRole('columnheader',{name:'Estimates'})).toHaveAttribute('colspan','3');
  ['2Q26','3Q26E','4Q26E','1Q27E'].forEach(label=>expect(screen.getByRole('columnheader',{name:label})).toBeInTheDocument());
  expect(screen.getByRole('rowheader',{name:'United States'})).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'1'})).toHaveAttribute('title',expect.stringContaining('Actual'));
  expect(screen.getByRole('link',{name:'4'})).toHaveAttribute('title',expect.stringContaining('Estimate'));
});
