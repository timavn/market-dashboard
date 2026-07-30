#!/usr/bin/env node
'use strict';

/*
 * Fail-closed validation for the three repository-owned AWS profiles.
 *
 * This module deliberately delegates profile resolution to AWS CLI. It never
 * opens a shared credentials/config file and never prints credential values or
 * caller identity data. The static session-token probe reduces stdout to a
 * whitespace-aware presence bit and discards the value so a copied token
 * cannot enter supervisor or installer logs.
 */
const { spawnSync } = require('node:child_process');

const EXPECTED_ACCOUNT_ID = '915328198276';
const DEFAULT_REGION = 'us-west-1';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MINIMUM_REMAINING_MS = 15 * 60_000;

const PROFILE_TARGETS = Object.freeze({
  api: Object.freeze({
    purpose: 'api',
    profile: 'market-dashboard-local',
    principalArn: `arn:aws:iam::${EXPECTED_ACCOUNT_ID}:user/market-dashboard-local`,
    provider: 'durable-user',
  }),
  bridge: Object.freeze({
    purpose: 'bridge',
    profile: 'market-dashboard-bridge',
    principalArn: `arn:aws:iam::${EXPECTED_ACCOUNT_ID}:user/market-dashboard-bridge`,
    provider: 'durable-user',
  }),
  admin: Object.freeze({
    purpose: 'admin',
    profile: 'market-dashboard-admin',
    provider: 'sso',
  }),
});

const AWS_CREDENTIAL_ENVIRONMENT_KEYS = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
]);

function isolatedAwsEnvironment(inheritedEnv = process.env, {
  profile,
  region = DEFAULT_REGION,
} = {}) {
  const environment = { ...inheritedEnv };
  for (const key of AWS_CREDENTIAL_ENVIRONMENT_KEYS) delete environment[key];
  delete environment.AWS_PROFILE;
  delete environment.AWS_DEFAULT_PROFILE;
  environment.AWS_PROFILE = profile;
  environment.AWS_DEFAULT_PROFILE = profile;
  environment.AWS_REGION = region;
  environment.AWS_DEFAULT_REGION = region;
  environment.AWS_SDK_LOAD_CONFIG = '1';
  environment.AWS_EC2_METADATA_DISABLED = 'true';
  environment.AWS_PAGER = '';
  return environment;
}

function sanitizeAwsProcessResult(result, {
  capture = false,
  sensitivePresenceOnly = false,
} = {}) {
  const rawStdout = capture || sensitivePresenceOnly
    ? String(result?.stdout || '')
    : '';
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    stdout: capture && !sensitivePresenceOnly ? rawStdout : '',
    stderr: capture && !sensitivePresenceOnly ? String(result?.stderr || '') : '',
    hasNonWhitespaceOutput: sensitivePresenceOnly ? /\S/.test(rawStdout) : null,
    errorCode: result?.error?.code || null,
    signal: result?.signal || null,
  };
}

function runAwsCli(args, {
  capture = false,
  sensitivePresenceOnly = false,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const captureProcessOutput = capture || sensitivePresenceOnly;
  const result = spawnSync('aws', args, {
    encoding: captureProcessOutput ? 'utf8' : undefined,
    env,
    stdio: captureProcessOutput
      ? ['ignore', 'pipe', sensitivePresenceOnly ? 'ignore' : 'pipe']
      : 'ignore',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
  });
  return sanitizeAwsProcessResult(result, { capture, sensitivePresenceOnly });
}

function resultError(errorCode, detail, target) {
  return {
    ok: false,
    purpose: target?.purpose || null,
    profile: target?.profile || null,
    errorCode,
    detail,
  };
}

function staticProfileFieldIsSet(fieldName, target, runAws, environment, timeoutMs) {
  const result = runAws([
    'configure',
    'get',
    fieldName,
    '--profile',
    target.profile,
  ], {
    capture: false,
    sensitivePresenceOnly: true,
    env: environment,
    timeoutMs,
  });
  const presenceUnverified = result.status === 0
    && typeof result.hasNonWhitespaceOutput !== 'boolean';
  return {
    set: result.status === 0 && result.hasNonWhitespaceOutput === true,
    executionError: result.errorCode || (
      presenceUnverified || (result.status !== 0 && result.status !== 1)
        ? 'AWS_CONFIG_QUERY_FAILED'
        : null
    ),
  };
}

function classifyStsFailure(result) {
  const diagnostic = String(result?.stderr || '');
  if (
    /ExpiredToken|token has expired|SSO session[^.\n]*expired|credentials[^.\n]*expired/i
      .test(diagnostic)
  ) {
    return 'AWS_PROFILE_EXPIRED';
  }
  if (result?.errorCode === 'ENOENT') return 'AWS_CLI_UNAVAILABLE';
  return 'AWS_PROFILE_UNUSABLE';
}

function validateRefreshableExpiration(result, {
  now = Date.now(),
  minimumRemainingMs = DEFAULT_MINIMUM_REMAINING_MS,
} = {}) {
  if (result?.status !== 0) {
    return {
      ok: false,
      errorCode: classifyStsFailure(result),
    };
  }
  let expiration;
  try {
    const credentialEnvelope = JSON.parse(String(result.stdout || ''));
    expiration = Date.parse(String(credentialEnvelope?.Expiration || ''));
  } catch {
    expiration = Number.NaN;
  }
  if (!Number.isFinite(expiration)) {
    return {
      ok: false,
      errorCode: 'AWS_PROFILE_EXPIRATION_UNVERIFIED',
    };
  }
  const remainingMs = expiration - now;
  if (remainingMs <= 0) {
    return {
      ok: false,
      errorCode: 'AWS_PROFILE_EXPIRED',
    };
  }
  if (remainingMs < minimumRemainingMs) {
    return {
      ok: false,
      errorCode: 'AWS_PROFILE_EXPIRING_SOON',
    };
  }
  return {
    ok: true,
    errorCode: null,
  };
}

function validateCallerIdentity(identity, target) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  if (String(identity.Account || '') !== EXPECTED_ACCOUNT_ID) return false;
  const arn = String(identity.Arn || '');
  if (target.provider === 'durable-user') return arn === target.principalArn;
  return arn.startsWith(`arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/`);
}

function preflightAwsProfile({
  purpose,
  profile,
  env = process.env,
  region = DEFAULT_REGION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minimumRemainingMs = DEFAULT_MINIMUM_REMAINING_MS,
  now = Date.now(),
  runAws = runAwsCli,
} = {}) {
  const target = PROFILE_TARGETS[purpose];
  if (!target) {
    return resultError(
      'AWS_PROFILE_PURPOSE_INVALID',
      'AWS profile preflight requires an approved purpose.',
      null,
    );
  }
  const requestedProfile = String(profile || target.profile).trim();
  if (requestedProfile !== target.profile) {
    return resultError(
      'AWS_PROFILE_NAME_INVALID',
      `The ${purpose} service must use its dedicated ${target.profile} profile.`,
      target,
    );
  }

  const environment = isolatedAwsEnvironment(env, {
    profile: target.profile,
    region,
  });
  for (const fieldName of ['aws_session_token', 'aws_security_token']) {
    const sessionToken = staticProfileFieldIsSet(
      fieldName,
      target,
      runAws,
      environment,
      timeoutMs,
    );
    if (sessionToken.executionError) {
      return resultError(
        sessionToken.executionError === 'ENOENT'
          ? 'AWS_CLI_UNAVAILABLE'
          : 'AWS_PROFILE_UNUSABLE',
        sessionToken.executionError === 'ENOENT'
          ? 'AWS CLI is required for the credential preflight.'
          : `${target.profile} could not be validated.`,
        target,
      );
    }
    if (sessionToken.set) {
      return resultError(
        'AWS_PROFILE_STATIC_SESSION_REJECTED',
        `${target.profile} contains copied temporary session credentials; use the approved durable provider.`,
        target,
      );
    }
  }

  if (target.provider === 'sso') {
    const ssoSession = staticProfileFieldIsSet(
      'sso_session',
      target,
      runAws,
      environment,
      timeoutMs,
    );
    const legacySsoStartUrl = staticProfileFieldIsSet(
      'sso_start_url',
      target,
      runAws,
      environment,
      timeoutMs,
    );
    if (ssoSession.executionError || legacySsoStartUrl.executionError) {
      const cliMissing = [ssoSession.executionError, legacySsoStartUrl.executionError]
        .includes('ENOENT');
      return resultError(
        cliMissing ? 'AWS_CLI_UNAVAILABLE' : 'AWS_PROFILE_UNUSABLE',
        cliMissing
          ? 'AWS CLI is required for the credential preflight.'
          : `${target.profile} could not be validated.`,
        target,
      );
    }
    if (!ssoSession.set && !legacySsoStartUrl.set) {
      return resultError(
        'AWS_PROFILE_PROVIDER_INVALID',
        `${target.profile} must be an IAM Identity Center profile.`,
        target,
      );
    }
    const exportedCredentials = runAws([
      'configure',
      'export-credentials',
      '--profile',
      target.profile,
      '--format',
      'process',
    ], {
      capture: true,
      env: environment,
      timeoutMs,
    });
    const expiration = validateRefreshableExpiration(exportedCredentials, {
      now,
      minimumRemainingMs,
    });
    if (!expiration.ok) {
      let detail = `${target.profile} has no usable refreshable credentials.`;
      if (expiration.errorCode === 'AWS_PROFILE_EXPIRED') {
        detail = `${target.profile} credentials are expired; refresh the approved provider.`;
      } else if (expiration.errorCode === 'AWS_PROFILE_EXPIRING_SOON') {
        detail = `${target.profile} credentials expire too soon; refresh the approved provider.`;
      } else if (expiration.errorCode === 'AWS_CLI_UNAVAILABLE') {
        detail = 'AWS CLI is required for the credential preflight.';
      } else if (expiration.errorCode === 'AWS_PROFILE_EXPIRATION_UNVERIFIED') {
        detail = `${target.profile} credential expiration could not be verified.`;
      }
      return resultError(expiration.errorCode, detail, target);
    }
  }

  const identityResult = runAws([
    'sts',
    'get-caller-identity',
    '--profile',
    target.profile,
    '--region',
    region,
    '--output',
    'json',
  ], {
    capture: true,
    env: environment,
    timeoutMs,
  });
  if (identityResult.status !== 0) {
    const errorCode = classifyStsFailure(identityResult);
    const detail = errorCode === 'AWS_PROFILE_EXPIRED'
      ? `${target.profile} credentials are expired; refresh the approved provider.`
      : (
        errorCode === 'AWS_CLI_UNAVAILABLE'
          ? 'AWS CLI is required for the credential preflight.'
          : `${target.profile} has no usable credentials.`
      );
    return resultError(errorCode, detail, target);
  }

  let identity;
  try {
    identity = JSON.parse(identityResult.stdout);
  } catch {
    return resultError(
      'AWS_PROFILE_RESPONSE_INVALID',
      `${target.profile} returned an invalid identity response.`,
      target,
    );
  }
  if (!validateCallerIdentity(identity, target)) {
    return resultError(
      'AWS_PROFILE_WRONG_PRINCIPAL',
      `${target.profile} resolves to the wrong AWS principal.`,
      target,
    );
  }
  return {
    ok: true,
    purpose: target.purpose,
    profile: target.profile,
    errorCode: null,
    detail: `${target.profile} resolved to its approved ${purpose} identity.`,
  };
}

function parseCliArgs(argv) {
  const options = { purpose: null, profile: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--purpose') {
      options.purpose = argv[index + 1] || null;
      index += 1;
    } else if (value === '--profile') {
      options.profile = argv[index + 1] || null;
      index += 1;
    } else if (value === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function publicResult(result) {
  return {
    ok: result.ok,
    purpose: result.purpose,
    profile: result.profile,
    errorCode: result.errorCode,
    detail: result.detail,
  };
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`AWS profile preflight: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const result = preflightAwsProfile(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(publicResult(result))}\n`);
  } else if (result.ok) {
    process.stdout.write(`AWS profile preflight passed for ${result.purpose}.\n`);
  } else {
    process.stderr.write(`AWS profile preflight failed (${result.errorCode}): ${result.detail}\n`);
  }
  process.exitCode = result.ok ? 0 : 2;
}

if (require.main === module) main();

module.exports = {
  AWS_CREDENTIAL_ENVIRONMENT_KEYS,
  DEFAULT_MINIMUM_REMAINING_MS,
  DEFAULT_REGION,
  PROFILE_TARGETS,
  classifyStsFailure,
  isolatedAwsEnvironment,
  parseCliArgs,
  preflightAwsProfile,
  publicResult,
  runAwsCli,
  sanitizeAwsProcessResult,
  validateCallerIdentity,
  validateRefreshableExpiration,
};
