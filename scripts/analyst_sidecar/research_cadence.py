"""Compare source report dates with the publication schedule they belong to."""

from datetime import date, timedelta


def publication_matches_expected(product, publication_date, expected_date):
    try:
        publication = date.fromisoformat(publication_date)
        expected = date.fromisoformat(expected_date)
    except (TypeError, ValueError):
        return False
    if product.get("cadence") == "weekly" and product.get("publicationDateBasis") == "reporting-week":
        # CFTC keys observations by their official report date, normally Tuesday,
        # rather than Friday's release. Allow official weekday shifts within the
        # same reporting week without accepting the previous week's observations.
        start = expected - timedelta(days=expected.weekday())
        return start <= publication <= expected
    return publication == expected
