"""The Gmail cost guard preserves slow polling at every scheduler phase."""

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "lambdas" / "gmail_ingestor" / "analyst_cost_guard.py"
SPEC = importlib.util.spec_from_file_location("gmail_analyst_cost_guard", MODULE_PATH)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class AnalystCostGuardTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 14, 18, 35, 55, tzinfo=timezone.utc)
        self.event = {"source": "aws-scheduler", "scheduleId": guard.SCHEDULE}
        self.dynamodb = MagicMock()
        self.ledger = self.dynamodb.Table.return_value
        self.measurement = {
            "complete": True,
            "cadenceMinutes": 15,
            "projectedMonthly": 15.44,
            "measuredAt": self.now.isoformat(),
        }
        self.ledger.get_item.return_value = {"Item": {"measurement": self.measurement}}
        self.scheduler = MagicMock()
        self.schedule = {
            "Name": guard.SCHEDULE,
            "State": "ENABLED",
            "ScheduleExpression": "rate(15 minutes)",
            "Target": {"Arn": "existing-target", "Input": "existing-input"},
            "FlexibleTimeWindow": {"Mode": "OFF"},
        }
        self.scheduler.get_schedule.return_value = self.schedule
        self.environment = patch.dict(guard.os.environ, {"ANALYST_FAST_POLLING_ENABLED": "1"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.clients = patch.object(guard.boto3, "client", return_value=self.scheduler)
        self.clients.start()
        self.addCleanup(self.clients.stop)

    def test_slow_schedule_runs_at_its_actual_non_quarter_hour_phase(self):
        for minute in (5, 20, 35, 50):
            with self.subTest(minute=minute):
                self.assertTrue(guard.check_fast_polling(
                    self.event, self.dynamodb, now=self.now.replace(minute=minute),
                ))
        self.scheduler.update_schedule.assert_not_called()

    def test_threshold_transition_skips_fast_invocation_then_allows_slow_run(self):
        self.schedule["ScheduleExpression"] = "rate(1 minute)"
        self.assertFalse(guard.check_fast_polling(self.event, self.dynamodb, now=self.now))
        self.scheduler.update_schedule.assert_called_once_with(
            **{**self.schedule, "ScheduleExpression": "rate(15 minutes)"},
        )
        self.schedule["ScheduleExpression"] = "rate(15 minutes)"
        self.assertTrue(guard.check_fast_polling(
            self.event, self.dynamodb, now=self.now.replace(minute=50),
        ))
        self.assertEqual(self.scheduler.update_schedule.call_count, 1)

    def test_incomplete_cost_evidence_allows_only_confirmed_slow_schedule(self):
        self.measurement["complete"] = False
        self.assertTrue(guard.check_fast_polling(self.event, self.dynamodb, now=self.now))
        self.schedule["ScheduleExpression"] = "rate(1 minute)"
        self.assertFalse(guard.check_fast_polling(self.event, self.dynamodb, now=self.now))

    def test_unreadable_cost_evidence_still_allows_confirmed_slow_schedule(self):
        self.ledger.get_item.side_effect = RuntimeError("cost evidence unavailable")
        self.assertTrue(guard.check_fast_polling(self.event, self.dynamodb, now=self.now))
        self.scheduler.update_schedule.assert_not_called()

    def test_unverified_scheduler_cadence_fails_closed_even_on_quarter_hour(self):
        self.scheduler.get_schedule.side_effect = RuntimeError("scheduler unavailable")
        self.assertFalse(guard.check_fast_polling(
            self.event, self.dynamodb, now=self.now.replace(minute=30),
        ))

    def test_failed_slowdown_update_does_not_allow_fast_work(self):
        self.schedule["ScheduleExpression"] = "rate(1 minute)"
        self.scheduler.update_schedule.side_effect = RuntimeError("update unavailable")
        self.assertFalse(guard.check_fast_polling(self.event, self.dynamodb, now=self.now))

    def test_safe_one_minute_measurement_keeps_fast_work_eligible(self):
        self.measurement["cadenceMinutes"] = 1
        self.assertTrue(guard.check_fast_polling(self.event, self.dynamodb, now=self.now))
        self.scheduler.get_schedule.assert_not_called()

    def test_manual_targeted_recovery_does_not_change_the_schedule(self):
        self.assertTrue(guard.check_fast_polling(
            {"source": "manual-risk-range-recovery", "messageIds": ["source-message"]},
            self.dynamodb, now=self.now,
        ))
        self.ledger.get_item.assert_not_called()
        self.scheduler.get_schedule.assert_not_called()

    def test_disabled_fast_polling_does_not_touch_the_schedule(self):
        with patch.dict(guard.os.environ, {"ANALYST_FAST_POLLING_ENABLED": "0"}):
            self.assertTrue(guard.check_fast_polling(self.event, self.dynamodb, now=self.now))
        self.ledger.get_item.assert_not_called()
        self.scheduler.get_schedule.assert_not_called()


if __name__ == "__main__":
    unittest.main()
