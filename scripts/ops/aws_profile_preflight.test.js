'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AWS_CREDENTIAL_ENVIRONMENT_KEYS,
  PROFILE_TARGETS,
  isolatedAwsEnvironment,
  parseCliArgs,
  preflightAwsProfile,
  publicResult,
  sanitizeAwsProcessResult,
  validateCallerIdentity,
  validateRefreshableExpiration,
} = require('./aws_profile_preflight');

function fakeAwsRunner({
  staticSession = false,
  legacyStaticSession = false,
  ssoSession = false,
  legacySso = false,
  identity,
  stsStatus = 0,
  stsStderr = '',
  stsErrorCode = null,
  exportStatus = 0,
  exportStderr = '',
  expiration = '2999-01-01T00:00:00.000Z',
} = {}) {
  const calls = [];
  const run = (args, options = {}) => {
    calls.push({ args: [...args], options });
    if (args[0] === 'configure' && args[1] === 'export-credentials') {
      return {
        status: exportStatus,
        stdout: exportStatus === 0
          ? JSON.stringify({
            Version: 1,
            AccessKeyId: 'must-never-be-reported',
            SecretAccessKey: 'must-never-be-reported',
            SessionToken: 'must-never-be-reported',
            Expiration: expiration,
          })
          : '',
        stderr: exportStderr,
        errorCode: null,
      };
    }
    if (args[0] === 'configure') {
      const field = args[2];
      const configuredSetting = field === 'aws_session_token'
        ? staticSession
        : (
          field === 'aws_security_token'
            ? legacyStaticSession
            : (field === 'sso_session' ? ssoSession : legacySso)
        );
      const configured = configuredSetting !== false;
      const configuredValue = typeof configuredSetting === 'string'
        ? configuredSetting
        : (configured ? 'configured-value' : '');
      return {
        status: configured ? 0 : 1,
        stdout: '',
        stderr: '',
        hasNonWhitespaceOutput: options.sensitivePresenceOnly
          ? /\S/.test(configuredValue)
          : null,
        errorCode: null,
      };
    }
    return {
      status: stsStatus,
      stdout: stsStatus === 0 ? JSON.stringify(identity) : '',
      stderr: stsStderr,
      errorCode: stsErrorCode,
    };
  };
  return { calls, run };
}

test('API preflight accepts only the durable local IAM-user identity', () => {
  const fake = fakeAwsRunner({
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
      UserId: 'not-exposed',
    },
  });
  const result = preflightAwsProfile({
    purpose: 'api',
    runAws: fake.run,
    env: {
      AWS_ACCESS_KEY_ID: 'ambient-key',
      AWS_SECRET_ACCESS_KEY: 'ambient-secret',
      AWS_SESSION_TOKEN: 'ambient-token',
      AWS_PROFILE: 'wrong-profile',
      PATH: '/usr/bin',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile, 'market-dashboard-local');
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0].args[2], 'aws_session_token');
  assert.equal(fake.calls[0].options.capture, false);
  assert.equal(fake.calls[0].options.sensitivePresenceOnly, true);
  assert.equal(fake.calls[0].options.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(fake.calls[0].options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(fake.calls[0].options.env.AWS_SESSION_TOKEN, undefined);
  assert.equal(fake.calls[0].options.env.AWS_PROFILE, 'market-dashboard-local');
  assert.equal(fake.calls[1].args[2], 'aws_security_token');
  assert.equal(fake.calls[1].options.capture, false);
  assert.equal(fake.calls[1].options.sensitivePresenceOnly, true);
  assert.equal(fake.calls[2].options.capture, true);
  assert.doesNotMatch(JSON.stringify(publicResult(result)), /not-exposed|915328198276|arn:aws/);
});

test('bridge preflight requires its distinct bridge IAM-user identity', () => {
  const fake = fakeAwsRunner({
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-bridge',
    },
  });
  assert.deepEqual(preflightAwsProfile({
    purpose: 'bridge',
    profile: 'market-dashboard-bridge',
    runAws: fake.run,
  }), {
    ok: true,
    purpose: 'bridge',
    profile: 'market-dashboard-bridge',
    errorCode: null,
    detail: 'market-dashboard-bridge resolved to its approved bridge identity.',
  });
});

test('copied static session credentials are rejected without capturing the token', () => {
  const fake = fakeAwsRunner({
    staticSession: true,
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
    },
  });
  const result = preflightAwsProfile({
    purpose: 'api',
    runAws: fake.run,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'AWS_PROFILE_STATIC_SESSION_REJECTED');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.capture, false);
  assert.equal(fake.calls[0].options.sensitivePresenceOnly, true);
  assert.doesNotMatch(JSON.stringify(result), /access|secret|token-value/i);
});

test('a blank configured session-token key is treated as absent', () => {
  const fake = fakeAwsRunner({
    staticSession: '  \n\t',
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
    },
  });
  const result = preflightAwsProfile({
    purpose: 'api',
    runAws: fake.run,
  });
  assert.equal(result.ok, true);
  assert.equal(fake.calls[0].args[2], 'aws_session_token');
  assert.equal(fake.calls[0].options.sensitivePresenceOnly, true);
});

test('legacy copied security-token credentials are also rejected without capture', () => {
  const fake = fakeAwsRunner({
    legacyStaticSession: true,
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
    },
  });
  const result = preflightAwsProfile({
    purpose: 'api',
    runAws: fake.run,
  });
  assert.equal(result.errorCode, 'AWS_PROFILE_STATIC_SESSION_REJECTED');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].args[2], 'aws_security_token');
  assert.equal(fake.calls[1].options.capture, false);
});

test('a blank configured legacy security-token key is treated as absent', () => {
  const fake = fakeAwsRunner({
    legacyStaticSession: '\n ',
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
    },
  });
  const result = preflightAwsProfile({
    purpose: 'api',
    runAws: fake.run,
  });
  assert.equal(result.ok, true);
  assert.equal(fake.calls[1].args[2], 'aws_security_token');
  assert.equal(fake.calls[1].options.sensitivePresenceOnly, true);
});

test('sensitive presence reduction distinguishes blank values without returning tokens', () => {
  const populated = sanitizeAwsProcessResult({
    status: 0,
    stdout: 'must-never-be-reported\n',
    stderr: 'also-discarded',
  }, {
    sensitivePresenceOnly: true,
  });
  assert.deepEqual(populated, {
    status: 0,
    stdout: '',
    stderr: '',
    hasNonWhitespaceOutput: true,
    errorCode: null,
    signal: null,
  });
  assert.doesNotMatch(JSON.stringify(populated), /must-never-be-reported|also-discarded/);

  const blank = sanitizeAwsProcessResult({
    status: 0,
    stdout: ' \n\t',
  }, {
    sensitivePresenceOnly: true,
  });
  assert.equal(blank.hasNonWhitespaceOutput, false);
  assert.equal(blank.stdout, '');
});

test('expired and otherwise unusable profiles produce typed safe failures', () => {
  const expired = fakeAwsRunner({
    stsStatus: 255,
    stsStderr: 'An error occurred (ExpiredToken) when calling the operation.',
  });
  const expiredResult = preflightAwsProfile({
    purpose: 'api',
    runAws: expired.run,
  });
  assert.equal(expiredResult.errorCode, 'AWS_PROFILE_EXPIRED');
  assert.doesNotMatch(JSON.stringify(expiredResult), /ExpiredToken/);

  const unavailable = fakeAwsRunner({
    stsStatus: 255,
    stsStderr: 'Unable to locate credentials.',
  });
  const unavailableResult = preflightAwsProfile({
    purpose: 'bridge',
    runAws: unavailable.run,
  });
  assert.equal(unavailableResult.errorCode, 'AWS_PROFILE_UNUSABLE');
  assert.equal(unavailableResult.detail, 'market-dashboard-bridge has no usable credentials.');
});

test('API and bridge reject each other, administrators, and identities in another account', () => {
  for (const [purpose, identity] of [
    ['api', {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-bridge',
    }],
    ['bridge', {
      Account: '915328198276',
      Arn: 'arn:aws:sts::915328198276:assumed-role/Administrator/operator',
    }],
    ['api', {
      Account: '111111111111',
      Arn: 'arn:aws:iam::111111111111:user/market-dashboard-local',
    }],
  ]) {
    const fake = fakeAwsRunner({ identity });
    const result = preflightAwsProfile({ purpose, runAws: fake.run });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'AWS_PROFILE_WRONG_PRINCIPAL');
    assert.doesNotMatch(JSON.stringify(result), /arn:aws|111111111111|915328198276/);
  }
});

test('profile aliases are rejected before AWS is called', () => {
  let calls = 0;
  const result = preflightAwsProfile({
    purpose: 'bridge',
    profile: 'copied-admin-session',
    runAws() {
      calls += 1;
      throw new Error('must not run');
    },
  });
  assert.equal(result.errorCode, 'AWS_PROFILE_NAME_INVALID');
  assert.equal(calls, 0);
});

test('admin preflight accepts refreshable SSO and rejects non-SSO providers', () => {
  const sso = fakeAwsRunner({
    ssoSession: true,
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:sts::915328198276:assumed-role/AWSReservedSSO_Administrator/operator',
    },
  });
  const ssoResult = preflightAwsProfile({
    purpose: 'admin',
    runAws: sso.run,
  });
  assert.equal(ssoResult.ok, true);
  assert.doesNotMatch(JSON.stringify(ssoResult), /must-never-be-reported/);
  assert.equal(
    sso.calls.some(call => call.args[1] === 'export-credentials'),
    true,
  );

  const staticUser = fakeAwsRunner({
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-admin',
    },
  });
  const result = preflightAwsProfile({
    purpose: 'admin',
    runAws: staticUser.run,
  });
  assert.equal(result.errorCode, 'AWS_PROFILE_PROVIDER_INVALID');
  assert.equal(staticUser.calls.some(call => call.args[0] === 'sts'), false);
});

test('admin SSO credentials are rejected when expired, near expiry, or unverifiable', () => {
  const now = Date.parse('2026-07-29T18:00:00.000Z');
  for (const [expiration, errorCode] of [
    ['2026-07-29T17:59:59.000Z', 'AWS_PROFILE_EXPIRED'],
    ['2026-07-29T18:14:59.000Z', 'AWS_PROFILE_EXPIRING_SOON'],
    ['', 'AWS_PROFILE_EXPIRATION_UNVERIFIED'],
  ]) {
    const fake = fakeAwsRunner({
      ssoSession: true,
      expiration,
      identity: {
        Account: '915328198276',
        Arn: 'arn:aws:sts::915328198276:assumed-role/Admin/operator',
      },
    });
    const result = preflightAwsProfile({
      purpose: 'admin',
      runAws: fake.run,
      now,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, errorCode);
    assert.equal(fake.calls.some(call => call.args[0] === 'sts'), false);
    assert.doesNotMatch(JSON.stringify(result), /must-never-be-reported/);
  }

  const boundary = fakeAwsRunner({
    ssoSession: true,
    expiration: '2026-07-29T18:15:00.000Z',
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:sts::915328198276:assumed-role/Admin/operator',
    },
  });
  assert.equal(preflightAwsProfile({
    purpose: 'admin',
    runAws: boundary.run,
    now,
  }).ok, true);
});

test('a refreshable provider may resolve API credentials only when STS proves the exact user', () => {
  const credentialProcess = fakeAwsRunner({
    identity: {
      Account: '915328198276',
      Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
    },
  });
  const result = preflightAwsProfile({
    purpose: 'api',
    runAws: credentialProcess.run,
  });
  assert.equal(result.ok, true);
});

test('invalid STS JSON and a missing AWS CLI fail closed', () => {
  const invalidJson = fakeAwsRunner({
    identity: null,
  });
  invalidJson.run = (args, options) => {
    if (args[0] === 'configure') {
      return { status: 1, stdout: '', stderr: '', errorCode: null };
    }
    return { status: 0, stdout: '{invalid', stderr: '', errorCode: null };
  };
  assert.equal(preflightAwsProfile({
    purpose: 'api',
    runAws: invalidJson.run,
  }).errorCode, 'AWS_PROFILE_RESPONSE_INVALID');

  const missingCli = () => ({
    status: null,
    stdout: '',
    stderr: '',
    errorCode: 'ENOENT',
  });
  assert.equal(preflightAwsProfile({
    purpose: 'api',
    runAws: missingCli,
  }).errorCode, 'AWS_CLI_UNAVAILABLE');
});

test('isolated AWS environments remove every ambient credential source', () => {
  const inherited = Object.fromEntries(
    AWS_CREDENTIAL_ENVIRONMENT_KEYS.map((key) => [key, `untrusted-${key}`]),
  );
  inherited.AWS_PROFILE = 'admin';
  inherited.AWS_DEFAULT_PROFILE = 'admin';
  inherited.PATH = '/opt/homebrew/bin:/usr/bin';

  const environment = isolatedAwsEnvironment(inherited, {
    profile: PROFILE_TARGETS.bridge.profile,
  });
  for (const key of AWS_CREDENTIAL_ENVIRONMENT_KEYS) {
    assert.equal(environment[key], undefined);
  }
  assert.equal(environment.AWS_PROFILE, 'market-dashboard-bridge');
  assert.equal(environment.AWS_DEFAULT_PROFILE, 'market-dashboard-bridge');
  assert.equal(environment.AWS_REGION, 'us-west-1');
  assert.equal(environment.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(environment.PATH, inherited.PATH);
});

test('CLI arguments are explicit and reject unknown flags', () => {
  assert.deepEqual(parseCliArgs([
    '--purpose',
    'bridge',
    '--profile',
    'market-dashboard-bridge',
    '--json',
  ]), {
    purpose: 'bridge',
    profile: 'market-dashboard-bridge',
    json: true,
  });
  assert.throws(() => parseCliArgs(['--all']), /Unknown argument/);
});

test('caller identity validation implements the exact principal contract', () => {
  assert.equal(validateCallerIdentity({
    Account: '915328198276',
    Arn: 'arn:aws:iam::915328198276:user/market-dashboard-local',
  }, PROFILE_TARGETS.api), true);
  assert.equal(validateCallerIdentity({
    Account: '915328198276',
    Arn: 'arn:aws:iam::915328198276:user/market-dashboard-bridge',
  }, PROFILE_TARGETS.api), false);
  assert.equal(validateCallerIdentity({
    Account: '915328198276',
    Arn: 'arn:aws:sts::915328198276:assumed-role/Admin/operator',
  }, PROFILE_TARGETS.admin), true);
});

test('refreshable expiration validation never returns exported credential fields', () => {
  const result = validateRefreshableExpiration({
    status: 0,
    stdout: JSON.stringify({
      AccessKeyId: 'must-never-be-reported',
      SecretAccessKey: 'must-never-be-reported',
      SessionToken: 'must-never-be-reported',
      Expiration: '2026-07-29T18:30:00.000Z',
    }),
  }, {
    now: Date.parse('2026-07-29T18:00:00.000Z'),
  });
  assert.deepEqual(result, { ok: true, errorCode: null });
  assert.doesNotMatch(JSON.stringify(result), /must-never-be-reported/);
});
