/**
 * Quad Ranking Utilities
 * Functions to calculate and format Quad regime rankings for securities
 */

import { QUAD_RANKINGS } from '../constants/quadRankings';
import { getSecurityCategory } from '../constants/securityCategoryMapping';

/**
 * Get Quad rankings for a security
 * @param {string} ticker - Security ticker symbol
 * @returns {Object|null} Object with quad1, quad2, quad3, quad4 rankings, or null if not found
 */
export const getSecurityQuadRanking = (ticker) => {
  const categoryMapping = getSecurityCategory(ticker);
  
  if (!categoryMapping) {
    return null;
  }

  const { type, category } = categoryMapping;
  const rankings = QUAD_RANKINGS[type];
  
  if (!rankings) {
    return null;
  }

  return {
    quad1: rankings.quad1[category] || null,
    quad2: rankings.quad2[category] || null,
    quad3: rankings.quad3[category] || null,
    quad4: rankings.quad4[category] || null
  };
};

/**
 * Format Quad ranking as "Strongest/2nd/3rd/Weakest" string
 * @param {Object|null} ranking - Ranking object with quad1-4 properties
 * @returns {string} Formatted string like "3/4/2/1" or "--" if no ranking
 */
export const formatQuadRanking = (ranking) => {
  if (!ranking) {
    return '--';
  }

  // Create array of quad rankings with their quad numbers
  const quadRanks = [
    { quad: 1, rank: ranking.quad1 },
    { quad: 2, rank: ranking.quad2 },
    { quad: 3, rank: ranking.quad3 },
    { quad: 4, rank: ranking.quad4 }
  ];

  // Separate quads with rankings and quads without
  const validRanks = quadRanks.filter(qr => qr.rank !== null);
  const missingQuads = quadRanks.filter(qr => qr.rank === null).map(qr => qr.quad);

  // If no valid ranks, return "--"
  if (validRanks.length === 0) {
    return '--';
  }

  // Sort valid ranks by rank value (lower rank = better performance = stronger)
  validRanks.sort((a, b) => a.rank - b.rank);

  // Format: Strongest/2nd/3rd/Weakest
  // Order: quads sorted by rank (strongest first) + missing quads (weakest, in descending order)
  const sortedQuadNumbers = validRanks.map(qr => qr.quad);
  const sortedMissingQuads = missingQuads.sort((a, b) => b - a); // Descending order
  const finalOrder = [...sortedQuadNumbers, ...sortedMissingQuads];
  
  // Format as string
  return finalOrder.join('/');
};

/**
 * Get formatted Quad ranking string for a security
 * @param {string} ticker - Security ticker symbol
 * @returns {string} Formatted Quad ranking (e.g., "3/4/2/1") or "--"
 */
export const getFormattedQuadRanking = (ticker) => {
  const ranking = getSecurityQuadRanking(ticker);
  return formatQuadRanking(ranking);
};

