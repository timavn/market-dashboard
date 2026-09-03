'use strict';

const ARCHIVE_RECORD_TYPE = 'GMAIL_HISTORICAL_BACKFILL_ARCHIVE';
const RESTORE_RECORD_TYPE = 'GMAIL_HISTORICAL_BACKFILL_RESTORE';
const ARCHIVE_REASON_CODE = 'GMAIL_HISTORICAL_BACKFILL_ARCHIVED';

const finiteCount = (value) => {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
};

const timestamp = (item, field) => {
  const value = item?.[field] || item?.updatedAt || item?.createdAt || null;
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : 0;
};

const latestBy = (items, field) => items.reduce(
  (latest, item) => (timestamp(item, field) > timestamp(latest, field) ? item : latest),
  null,
);

const buildHistoricalBackfillStatus = (items) => {
  const rows = Array.isArray(items) ? items : [];
  const archives = rows.filter((item) => (
    item?.recordType === ARCHIVE_RECORD_TYPE
    && item?.status === 'ARCHIVED'
    && item?.immutable === true
    && item?.reasonCode === ARCHIVE_REASON_CODE
  ));
  if (archives.length === 0) return null;

  const archive = latestBy(archives, 'archivedAt');
  const restores = rows.filter((item) => (
    item?.recordType === RESTORE_RECORD_TYPE
    && item?.status === 'RESTORED'
    && item?.immutable === true
    && item?.receiptId === archive?.receiptId
  ));
  const restore = restores.length ? latestBy(restores, 'restoredAt') : null;
  const restored = Boolean(
    restore && timestamp(restore, 'restoredAt') >= timestamp(archive, 'archivedAt')
  );
  const counts = archive?.queueCounts && typeof archive.queueCounts === 'object'
    ? archive.queueCounts
    : {};

  return {
    status: restored ? 'restored' : 'archived',
    archivedAt: archive.archivedAt || archive.updatedAt || archive.createdAt || null,
    reasonCode: archive.reasonCode,
    pendingCount: finiteCount(counts.PENDING),
    retryableCount: finiteCount(counts.RETRYABLE),
    quarantinedCount: finiteCount(counts.QUARANTINED),
    completedCount: finiteCount(counts.COMPLETED),
    totalCount: finiteCount(archive.queueTotalCount),
    ...(restored ? { restoredAt: restore.restoredAt || restore.updatedAt || null } : {}),
  };
};

module.exports = {
  ARCHIVE_REASON_CODE,
  ARCHIVE_RECORD_TYPE,
  RESTORE_RECORD_TYPE,
  buildHistoricalBackfillStatus,
};
