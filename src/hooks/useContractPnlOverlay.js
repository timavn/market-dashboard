import { CONTRACT_PNL_PANEL_DEFAULT_WIDTH } from '../constants/dashboardWorkspace';

const centeredOverlay = Object.freeze({
  prepare: () => CONTRACT_PNL_PANEL_DEFAULT_WIDTH,
  defaultWidth: CONTRACT_PNL_PANEL_DEFAULT_WIDTH,
  style: Object.freeze({}),
});

// The shared workspace shell positions Contract P&L against the viewport.
// Opening it over a retained window must not inherit that window's geometry.
export default function useContractPnlOverlay() {
  return centeredOverlay;
}
