import { MACRO_ASSET_TABS } from './constants';

function AssetTabs({ activeAssetClass, onChange }) {
  return (
    <div className="macro-tabs" role="tablist" aria-label="Asset class">
      {MACRO_ASSET_TABS.map(tab => (
        <button
          key={tab.assetClass}
          type="button"
          role="tab"
          aria-selected={activeAssetClass === tab.assetClass}
          className={`macro-tab ${activeAssetClass === tab.assetClass ? 'macro-tab-active' : ''}`}
          onClick={() => onChange(tab.assetClass)}
          title={tab.title}
        >
          {tab.assetClass}
        </button>
      ))}
    </div>
  );
}

export default AssetTabs;
