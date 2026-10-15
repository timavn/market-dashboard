"""Strict broker numeric scalars, shared before HTTP/SSE serialization."""

import math
import re
from decimal import Decimal
from numbers import Real
from typing import Any, Optional

# Same decimal/exponent grammar as Node's strictQuoteNumber. In particular,
# float(True), user-defined __float__, whitespace and partial strings are not evidence.
_DECIMAL_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def strict_finite_float(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        if _DECIMAL_NUMBER.fullmatch(value) is None:
            return None
    elif not isinstance(value, (Real, Decimal)):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def strict_contract_id(value: Any) -> Optional[int]:
    parsed = strict_finite_float(value)
    if parsed is None or not parsed.is_integer() or not 0 < parsed <= 9_007_199_254_740_991:
        return None
    return int(parsed)


def strict_market_data_type(value: Any) -> Optional[int]:
    """IBKR's wire enum is an integer; Python bool/float equality is not proof."""
    return value if type(value) is int and value in (1, 2, 3, 4) else None
