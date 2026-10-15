import React from 'react';
import { EXPOSURE_DIMENSIONS, getExposureDefinition } from '../../constants/quadExposureCatalog';

export default function QuadRankingExplanation({ classification }) {
  const { profile, exposure, ranking, reason } = classification;
  const secondary = profile.secondaryExposureIds
    .map(id => getExposureDefinition(id)?.label).filter(Boolean);
  const fits = ranking?.fits.slice().sort((left, right) => left.quad - right.quad);
  return (
    <div className="pcv2-quad-explanation">
      <p><strong>Quick takeaway.</strong>{' '}
        {ranking
          ? `${profile.symbol} uses ${exposure.label} in the four-quad +EV chart. Read ${ranking.orderText} from the most favorable chart placement to the least favorable. It is a guide to the economic backdrop for this exposure, not a buy/sell signal.`
          : reason}
      </p>
      {exposure && <p><strong>Classification.</strong>{' '}
        {EXPOSURE_DIMENSIONS[exposure.dimension].label} → {exposure.label}.
        {' '}{profile.classificationNote || 'This is the primary exposure selected in the reviewed security catalog.'}
        {secondary.length > 0 && ` Secondary exposures: ${secondary.join(', ')}. Only the primary exposure determines the order; secondary ranks are not averaged in.`}
      </p>}
      {ranking && <>
        <p><strong>Chart entries for {exposure.label}.</strong>{' '}
          {fits.map(fit => `Quad ${fit.quad}: ${fit.status === 'not-listed'
            ? 'not listed' : `${fit.status === 'best' ? 'Best' : 'Worst'} #${fit.rank}`}`).join('; ')}.
        </p>
        <p><strong>How the order is built.</strong> Best-list entries come first, with #1 strongest.
          Unlisted quads go in the middle. Worst-list entries come last, with Worst #1 weakest.
          Equal entries share a rank, shown with “=”. “Not listed” means the chart provides no rank;
          placing it in the middle is our display convention, not evidence of a neutral return.
        </p>
        <p><strong>Example.</strong> OIH maps to Energy. Energy is Best #2 in Quad 3, Best #4 in Quad 2,
          absent in Quad 1, and Worst #1 in Quad 4. That gives 3 → 2 → 1 → 4.
        </p>
        <p><strong>What this tells a PM.</strong> This compares a factor’s placement in the existing
          four-quad Best/Worst lists. It does not compare the factor’s actual average return across
          quads, or backtest this individual security. Ranks show order, not the size of a return gap.
          A holding’s long/short direction does not change its underlying classification or this order.
          Leverage, options, and a fund’s changing holdings can make its returns differ from the chosen factor.
        </p>
      </>}
      {!ranking && exposure && <p>
        The security is classified, but the chart has no matching backtested category.
        No quad order is assigned until there is a supported category or an explicitly chosen proxy.
      </p>}
      {profile.classificationSources?.length > 0 && <p><strong>Classification sources.</strong>{' '}
        {profile.classificationSources.map((url, index) => (
          <React.Fragment key={url}>
            {index > 0 && '; '}
            <a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname.replace(/^www\./, '')}</a>
          </React.Fragment>
        ))}.
        {profile.reviewedAt && ` Reviewed ${profile.reviewedAt}.`}
      </p>}
    </div>
  );
}
