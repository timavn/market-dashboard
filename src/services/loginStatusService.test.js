const { EventEmitter } = require('node:events');
const {
  AWS_PROFILE_TARGETS,
  IB_GATEWAY_BUNDLE_ID,
  aggregateLoginStatus,
  createAwsProfileProbe,
  createLoginActionService,
  createLoginStatusService,
  evaluateAwsLogin,
  evaluateGmailLogin,
  evaluateIbkrLogin,
  safeReason,
} = require('./loginStatusService.cjs');

const NOW = new Date('2026-08-07T18:00:00.000Z');
const GMAIL_ACCOUNT = 'dashboard@example.com';
const GMAIL_SCHEDULE = 'gmail-owned-schedule';

function ibkrEvidence(overrides = {}) {
  return {
    connected: true,
    status: 'connected',
    account_discovery_ok: true,
    accounts: ['U12345678'],
    time: new Date(NOW.getTime() - 1_000).toISOString(),
    ...overrides,
  };
}

function gmailStore(overrides = {}) {
  return {
    available: true,
    found: true,
    heartbeat: {
      serviceId: `gmail:${GMAIL_ACCOUNT}`,
      status: 'success',
      source: 'aws-lambda',
      triggerSource: 'aws-scheduler',
      scheduled: true,
      scheduleId: GMAIL_SCHEDULE,
      finishedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      ...overrides,
    },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('login status evaluators', () => {
  test('requires a fresh connected IBKR session with managed-account discovery', () => {
    expect(evaluateIbkrLogin(ibkrEvidence(), { now: NOW })).toMatchObject({
      status: 'online',
      state: 'connected',
      required: true,
    });
    expect(evaluateIbkrLogin(ibkrEvidence({ connected: false }), { now: NOW })).toMatchObject({
      status: 'offline',
      state: 'disconnected',
    });
    expect(evaluateIbkrLogin(ibkrEvidence({ accounts: [] }), { now: NOW })).toMatchObject({
      status: 'offline',
      state: 'invalid',
    });
    expect(evaluateIbkrLogin(ibkrEvidence({
      time: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    }), { now: NOW })).toMatchObject({
      status: 'unknown',
      state: 'stale',
    });
  });

  test('accepts current explicit Gmail auth proof and only successful legacy proof', () => {
    expect(evaluateGmailLogin(gmailStore({
      status: 'error',
      errorCode: 'GMAIL_INGEST_ERROR',
      authVerifiedAt: new Date(NOW.getTime() - 30_000).toISOString(),
    }), {
      account: GMAIL_ACCOUNT,
      scheduleId: GMAIL_SCHEDULE,
      now: NOW,
    })).toMatchObject({ status: 'online', state: 'fresh' });

    expect(evaluateGmailLogin(gmailStore(), {
      account: GMAIL_ACCOUNT,
      scheduleId: GMAIL_SCHEDULE,
      now: NOW,
    })).toMatchObject({ status: 'online', state: 'fresh' });

    expect(evaluateGmailLogin(gmailStore({ status: 'warning' }), {
      account: GMAIL_ACCOUNT,
      scheduleId: GMAIL_SCHEDULE,
      now: NOW,
    })).toMatchObject({ status: 'unknown', state: 'unverified' });
  });

  test('fails Gmail closed for explicit auth errors and unknown for bad provenance or stale proof', () => {
    expect(evaluateGmailLogin(gmailStore({
      status: 'auth_required',
      errorCode: 'GMAIL_AUTH_REQUIRED',
    }), {
      account: GMAIL_ACCOUNT,
      scheduleId: GMAIL_SCHEDULE,
      now: NOW,
    })).toMatchObject({ status: 'offline', state: 'expired' });

    expect(evaluateGmailLogin(gmailStore({ scheduleId: 'unowned-schedule' }), {
      account: GMAIL_ACCOUNT,
      scheduleId: GMAIL_SCHEDULE,
      now: NOW,
    })).toMatchObject({ status: 'unknown' });

    expect(evaluateGmailLogin(gmailStore({
      authVerifiedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    }), {
      account: GMAIL_ACCOUNT,
      scheduleId: GMAIL_SCHEDULE,
      now: NOW,
    })).toMatchObject({ status: 'unknown', state: 'stale' });
  });

  test('maps AWS fresh, expiring, signed-out, wrong-principal, timeout, and disabled states', () => {
    const admin = AWS_PROFILE_TARGETS.find(({ purpose }) => purpose === 'admin');
    const api = AWS_PROFILE_TARGETS.find(({ purpose }) => purpose === 'api');
    const bridge = AWS_PROFILE_TARGETS.find(({ purpose }) => purpose === 'bridge');
    expect(evaluateAwsLogin({
      ok: true,
      expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    }, admin, { now: NOW })).toMatchObject({ status: 'online', state: 'fresh' });
    expect(evaluateAwsLogin({
      ok: false,
      errorCode: 'AWS_PROFILE_EXPIRING_SOON',
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    }, admin, { now: NOW })).toMatchObject({ status: 'attention', state: 'expiring' });
    expect(evaluateAwsLogin({
      ok: false,
      errorCode: 'AWS_PROFILE_EXPIRED',
      expiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
    }, admin, { now: NOW })).toMatchObject({
      status: 'closed',
      state: 'signed_out',
      required: false,
      recovery: {
        kind: 'local-action',
        actionId: 'aws-admin-login',
        label: 'Refresh AWS SSO',
      },
    });
    expect(evaluateAwsLogin({
      ok: false,
      errorCode: 'AWS_PROFILE_WRONG_PRINCIPAL',
    }, api, { now: NOW })).toMatchObject({ status: 'offline', state: 'wrong_principal' });
    expect(evaluateAwsLogin({
      ok: false,
      errorCode: 'AWS_PROFILE_CHECK_TIMEOUT',
    }, api, { now: NOW })).toMatchObject({ status: 'unknown', state: 'unverified' });
    expect(evaluateAwsLogin({
      ok: false,
      errorCode: 'AWS_PROFILE_UNUSABLE',
    }, api, { now: NOW })).toMatchObject({ status: 'unknown', state: 'unverified' });
    expect(evaluateAwsLogin({ skipped: true }, bridge, {
      now: NOW,
      bridgeEnabled: false,
    })).toMatchObject({ status: 'closed', state: 'disabled', required: false });
  });

  test('aggregates required failures without optional administrator attention', () => {
    expect(aggregateLoginStatus([
      { required: true, status: 'online' },
      { required: false, status: 'attention' },
    ])).toBe('online');
    expect(aggregateLoginStatus([
      { required: true, status: 'unknown' },
      { required: false, status: 'offline' },
    ])).toBe('unknown');
    expect(aggregateLoginStatus([
      { required: true, status: 'offline' },
      { required: false, status: 'attention' },
    ])).toBe('offline');
  });
});

describe('cached login status service', () => {
  test('bounds hung fast and slow probes and reports them as unverified', async () => {
    const never = () => new Promise(() => {});
    const service = createLoginStatusService({
      readIbkr: never,
      readGmail: never,
      readAwsProfile: never,
      now: () => NOW,
      fastProbeTimeoutMs: 20,
      slowProbeTimeoutMs: 20,
      gmailAccount: GMAIL_ACCOUNT,
      gmailScheduleId: GMAIL_SCHEDULE,
    });
    const startedAt = Date.now();
    const report = await service.collect({ force: true });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(report.service.status).toBe('unknown');
    expect(report.service.details.find(({ id }) => id === 'ibkr-gateway')).toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/timeout/i),
    });
    expect(report.service.details.find(({ id }) => id === 'aws-api')).toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/timeout/i),
    });
    expect(report.service.details.some(({ id }) => id === 'kalshi-api')).toBe(false);
  });

  test('uses 60-second fast and five-minute slow cadences without overlap', async () => {
    let now = new Date(NOW);
    const readIbkr = jest.fn(async () => ibkrEvidence({ time: now.toISOString() }));
    const readGmail = jest.fn(async () => gmailStore({ authVerifiedAt: now.toISOString() }));
    const readAwsProfile = jest.fn(async () => ({ ok: true }));
    const service = createLoginStatusService({
      readIbkr,
      readGmail,
      readAwsProfile,
      now: () => now,
      gmailAccount: GMAIL_ACCOUNT,
      gmailScheduleId: GMAIL_SCHEDULE,
    });

    await service.collect();
    await service.collect();
    expect(readIbkr).toHaveBeenCalledTimes(1);
    expect(readGmail).toHaveBeenCalledTimes(1);
    expect(readAwsProfile).toHaveBeenCalledTimes(2);

    now = new Date(NOW.getTime() + 61_000);
    await service.collect();
    expect(readIbkr).toHaveBeenCalledTimes(2);
    expect(readGmail).toHaveBeenCalledTimes(2);
    expect(readAwsProfile).toHaveBeenCalledTimes(2);

    now = new Date(NOW.getTime() + 5 * 60_000 + 1);
    await service.collect();
    expect(readIbkr).toHaveBeenCalledTimes(3);
    expect(readGmail).toHaveBeenCalledTimes(3);
    expect(readAwsProfile).toHaveBeenCalledTimes(4);
  });

  test('coalesces concurrent forced collections and returns no secret or account material', async () => {
    let resolveIbkr;
    const ibkrPending = new Promise((resolve) => { resolveIbkr = resolve; });
    const readIbkr = jest.fn(() => ibkrPending);
    const service = createLoginStatusService({
      readIbkr,
      readGmail: async () => gmailStore({
        authVerifiedAt: NOW.toISOString(),
        refreshToken: 'gmail-refresh-secret',
      }),
      readAwsProfile: async () => ({
        ok: true,
        arn: 'arn:aws:iam::915328198276:user/should-not-leak',
      }),
      env: {
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
      },
      now: () => NOW,
      gmailAccount: GMAIL_ACCOUNT,
      gmailScheduleId: GMAIL_SCHEDULE,
    });

    const first = service.collect({ force: true });
    const second = service.collect({ force: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(readIbkr).toHaveBeenCalledTimes(1);
    resolveIbkr(ibkrEvidence({
      time: NOW.toISOString(),
      accounts: ['U12345678', 'U87654321'],
    }));
    const [firstReport, secondReport] = await Promise.all([first, second]);
    expect(firstReport).toEqual(secondReport);
    const serialized = JSON.stringify(firstReport);
    expect(serialized).not.toMatch(
      /U12345678|U87654321|gmail-refresh-secret|aws-secret|arn:aws|999999/,
    );
    expect(firstReport.service.details.every((detail) => (
      Object.keys(detail).every((key) => [
        'id', 'label', 'summary', 'status', 'state', 'required', 'checkedAt',
        'verifiedAt', 'expiresAt', 'reason', 'recovery',
      ].includes(key))
    ))).toBe(true);
  });
});

describe('fixed login probes and recovery actions', () => {
  test('runs the exact AWS profile preflight asynchronously and suppresses stderr', async () => {
    const child = fakeChild();
    const spawnProcess = jest.fn(() => child);
    const probe = createAwsProfileProbe({
      repoRoot: '/repo',
      spawnProcess,
      inheritedEnvironment: { AWS_SECRET_ACCESS_KEY: 'do-not-forward', SAFE: 'yes' },
    });
    const pending = probe(AWS_PROFILE_TARGETS[0]);
    child.stdout.emit('data', JSON.stringify({ ok: true }));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, errorCode: null, expiresAt: null });
    const [file, args, options] = spawnProcess.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([
      '/repo/scripts/ops/aws_profile_preflight.js',
      '--purpose', 'api',
      '--profile', 'market-dashboard-local',
      '--json',
    ]);
    expect(options).toMatchObject({ shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(options.env.SAFE).toBe('yes');
  });

  test('enforces loopback, allowlisting, exact process arguments, and independent action state', async () => {
    const children = [];
    const spawnProcess = jest.fn(() => {
      const child = fakeChild();
      children.push(child);
      setTimeout(() => child.emit('spawn'), 0);
      return child;
    });
    const service = createLoginActionService({
      repoRoot: '/repo',
      spawnProcess,
      inheritedEnvironment: { AWS_ACCESS_KEY_ID: 'must-not-forward', SAFE: 'yes' },
    });

    await expect(service.run('open-ibkr-gateway', { remoteAddress: '10.0.0.2' }))
      .rejects.toMatchObject({ code: 'LOGIN_ACTION_LOOPBACK_REQUIRED' });
    await expect(service.run('not-allowlisted', { remoteAddress: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'LOGIN_ACTION_NOT_ALLOWLISTED' });

    const first = service.run('open-ibkr-gateway', { remoteAddress: '::1' });
    await expect(first).resolves.toMatchObject({ accepted: true });
    expect(spawnProcess).toHaveBeenLastCalledWith(
      '/usr/bin/open',
      ['-b', IB_GATEWAY_BUNDLE_ID],
      expect.objectContaining({ shell: false, stdio: 'ignore' }),
    );
    expect(service.getStatus()['open-ibkr-gateway'].state).toBe('awaiting_user');
    children[0].emit('close', 0);

    const second = service.run('aws-admin-login', { remoteAddress: '::ffff:127.0.0.1' });
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      'aws',
      ['sso', 'logout'],
      expect.objectContaining({ shell: false, stdio: 'ignore' }),
    );
    children[1].emit('close', 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnProcess).toHaveBeenNthCalledWith(
      3,
      'aws',
      ['sso', 'login', '--profile', 'market-dashboard-admin'],
      expect.objectContaining({ shell: false, stdio: ['ignore', 'ignore', 'pipe'] }),
    );
    children[2].emit('spawn');
    await expect(second).resolves.toMatchObject({ accepted: true });
    const [, args, options] = spawnProcess.mock.calls[2];
    expect(args).toEqual(['sso', 'login', '--profile', 'market-dashboard-admin']);
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(options.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(options.env.SAFE).toBe('yes');
    expect(service.getStatus()['open-ibkr-gateway'].state).toBe('verifying');
    expect(service.getStatus()['aws-admin-login'].state).toBe('awaiting_user');
    children[2].emit('close', 0);
    service.syncVerification({
      service: {
        details: [
          { id: 'ibkr-gateway', status: 'online', verifiedAt: NOW.toISOString() },
          { id: 'aws-admin', status: 'online', verifiedAt: NOW.toISOString() },
        ],
      },
    });
    expect(service.getStatus()['open-ibkr-gateway'].state).toBe('ready');
    expect(service.getStatus()['aws-admin-login'].state).toBe('ready');
  });

  test('keeps an interactive action failed until its verification proof is available', async () => {
    const children = [];
    const service = createLoginActionService({
      spawnProcess: jest.fn((file) => {
        const child = fakeChild();
        children.push({ file, child });
        return child;
      }),
    });

    const pending = service.run('aws-admin-login', { remoteAddress: '127.0.0.1' });
    children[0].child.emit('close', 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    children[1].child.emit('spawn');
    await expect(pending).resolves.toMatchObject({ accepted: true, state: 'awaiting_user' });
    children[1].child.emit('close', 0);
    expect(service.getStatus()['aws-admin-login'].state).toBe('verifying');

    service.syncVerification({
      service: {
        details: [{ id: 'aws-admin', status: 'closed', state: 'signed_out' }],
      },
    });
    expect(service.getStatus()['aws-admin-login']).toMatchObject({
      state: 'failed',
      errorCode: 'AWS_ADMIN_LOGIN_REQUIRED',
    });
  });

  test('terminates and unlocks a bounded action that does not exit', async () => {
    jest.useFakeTimers();
    const children = [];
    const onSettled = jest.fn();
    const service = createLoginActionService({
      spawnProcess: jest.fn(() => {
        const child = fakeChild();
        children.push(child);
        return child;
      }),
      onSettled,
      actionTimeoutMs: 1_000,
    });

    const first = service.run('open-ibkr-gateway', { remoteAddress: '127.0.0.1' });
    children[0].emit('spawn');
    await expect(first).resolves.toMatchObject({ accepted: true });
    jest.advanceTimersByTime(15_000);
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(onSettled).toHaveBeenCalledWith('open-ibkr-gateway');

    const second = service.run('open-ibkr-gateway', { remoteAddress: '127.0.0.1' });
    children[1].emit('spawn');
    await expect(second).resolves.toMatchObject({ accepted: true });
    children[1].emit('close', 0);
    jest.useRealTimers();
  });

  test('redacts credential-shaped diagnostics', () => {
    const reason = safeReason(
      'refresh_token=super-secret password=hunter2 AKIA1234567890123456',
    );
    expect(reason).not.toMatch(/super-secret|hunter2|AKIA1234567890123456/);
  });
});
