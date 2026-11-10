'use strict';

// Repository-owned service adapters preserve existing request.promise() call
// sites while using the supported modular SDK. Only operations used by this
// application are exposed; there is no SDK-v2 dependency or double marshalling.
const { PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const s3Sdk = require('@aws-sdk/client-s3');
const ddbSdk = require('@aws-sdk/client-dynamodb');
const documentSdk = require('@aws-sdk/lib-dynamodb');
const lambdaSdk = require('@aws-sdk/client-lambda');
const sesSdk = require('@aws-sdk/client-ses');
const cloudwatchSdk = require('@aws-sdk/client-cloudwatch');
const stsSdk = require('@aws-sdk/client-sts');
const { fromIni } = require('@aws-sdk/credential-providers');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');

const config = {
  update(values = {}) {
    for (const [key, value] of Object.entries(values)) if (value !== undefined) this[key] = value;
  },
};

// The SDK sets no time limits of its own. Against an endpoint that accepts a
// connection and never answers, a request waits for ever, and so does the
// refresh that made it. A laptop waking from sleep can leave exactly that.
const CONNECTION_TIMEOUT_MS = 10_000;
// Longest silence allowed on an open DynamoDB request, which normally answers
// within a second. Not applied to S3 (a slow reader can pause a download) or
// Lambda (a synchronous run is silent until it returns). The SDK's
// `requestTimeout` is not used: in this version it only logs a warning.
const DYNAMODB_IDLE_TIMEOUT_MS = 20_000;
const positiveMs = (value) => (Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : undefined);

function clientOptions(options = {}, { idleTimeoutMs } = {}) {
  const merged = { ...config, ...options };
  const result = {};
  for (const key of ['region', 'credentials', 'endpoint', 'maxAttempts', 'retryMode', 'requestHandler', 'forcePathStyle']) {
    if (merged[key] !== undefined) result[key] = merged[key];
  }
  if (result.requestHandler === undefined) {
    // SDK v2 call sites name these httpOptions.connectTimeout and .timeout.
    const socketTimeout = positiveMs(merged.httpOptions?.timeout) ?? idleTimeoutMs;
    result.requestHandler = {
      connectionTimeout: positiveMs(merged.httpOptions?.connectTimeout) ?? CONNECTION_TIMEOUT_MS,
      ...(socketTimeout ? { socketTimeout } : {}),
    };
  }
  if (!result.credentials && merged.accessKeyId && merged.secretAccessKey) {
    result.credentials = { accessKeyId: merged.accessKeyId, secretAccessKey: merged.secretAccessKey,
      ...(merged.sessionToken ? { sessionToken: merged.sessionToken } : {}) };
  }
  if (merged.maxRetries != null) result.maxAttempts = Number(merged.maxRetries) + 1;
  return result;
}

function request(execute, callback) {
  let pending;
  const controller = new AbortController();
  const promise = () => {
    if (!pending) pending = Promise.resolve().then(() => execute(controller.signal)).catch((error) => {
      if (!error.code) error.code = error.name;
      throw error;
    });
    return pending;
  };
  if (callback) promise().then((value) => callback(null, value), callback);
  return { promise, abort: () => controller.abort() };
}

function methods(Adapter, sdk, operations) {
  for (const [method, command] of Object.entries(operations)) {
    Adapter.prototype[method] = function (params = {}, callback) {
      return request((abortSignal) => this.client.send(new sdk[command](params), { abortSignal }), callback);
    };
  }
}

class DocumentClient {
  constructor(options = {}) {
    this.client = options.client || documentSdk.DynamoDBDocumentClient.from(new ddbSdk.DynamoDBClient(clientOptions(options, { idleTimeoutMs: DYNAMODB_IDLE_TIMEOUT_MS })), {
      marshallOptions: { removeUndefinedValues: true, convertEmptyValues: options.convertEmptyValues === true },
      unmarshallOptions: { wrapNumbers: options.wrapNumbers === true },
    });
  }
}
methods(DocumentClient, documentSdk, {
  get: 'GetCommand', put: 'PutCommand', update: 'UpdateCommand', delete: 'DeleteCommand',
  query: 'QueryCommand', scan: 'ScanCommand', batchGet: 'BatchGetCommand', batchWrite: 'BatchWriteCommand',
  transactWrite: 'TransactWriteCommand', transactGet: 'TransactGetCommand',
});

class S3 {
  constructor(options = {}) {
    this.client = options.client || new s3Sdk.S3Client(clientOptions(options));
    this.maxBufferedObjectBytes = options.maxBufferedObjectBytes || 64 * 1024 * 1024;
  }
  getObject(params = {}, callback) {
    const operation = request(async (abortSignal) => {
      const result = await this.client.send(new s3Sdk.GetObjectCommand(params), { abortSignal });
      if (Number(result.ContentLength) > this.maxBufferedObjectBytes) {
        result.Body?.destroy?.();
        throw Object.assign(new Error('S3 object exceeds buffered read budget'), { code: 'OBJECT_TOO_LARGE' });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of result.Body || []) {
        const bytes = typeof chunk === 'number' ? Buffer.from([chunk]) : Buffer.from(chunk);
        size += bytes.length;
        if (size > this.maxBufferedObjectBytes) {
          result.Body?.destroy?.();
          throw Object.assign(new Error('S3 object exceeds buffered read budget'), { code: 'OBJECT_TOO_LARGE' });
        }
        chunks.push(bytes);
      }
      return { ...result, Body: Buffer.concat(chunks, size) };
    }, callback);
    operation.createReadStream = () => {
      const output = new PassThrough();
      const controller = new AbortController();
      output.once('close', () => controller.abort());
      this.client.send(new s3Sdk.GetObjectCommand(params), { abortSignal: controller.signal })
        .then((result) => pipeline(result.Body, output)).catch((error) => output.destroy(error));
      return output;
    };
    return operation;
  }
  getSignedUrlPromise(operation, params) {
    const command = { getObject: s3Sdk.GetObjectCommand, putObject: s3Sdk.PutObjectCommand }[operation];
    if (!command) return Promise.reject(new Error(`Unsupported signing operation: ${operation}`));
    const { Expires = 900, ...input } = params;
    return getSignedUrl(this.client, new command(input), { expiresIn: Expires });
  }
  createPresignedPost(params, callback) {
    // SDK v2 accepted the object key in Fields.key; both current upload
    // builders use that shape. v3 requires Key as a separate parameter.
    const pending = Promise.resolve().then(() => {
      const key = params.Key ?? params.Fields?.key;
      if (typeof key !== 'string' || !key || (params.Key != null && params.Fields?.key != null && params.Key !== params.Fields.key)) {
        throw Object.assign(new Error('A single matching upload object key is required'), { code: 'INVALID_POST_KEY' });
      }
      return createPresignedPost(this.client, { ...params, Key: key });
    });
    if (callback) pending.then((value) => callback(null, value), callback);
    return pending;
  }
}
methods(S3, s3Sdk, { putObject: 'PutObjectCommand', headObject: 'HeadObjectCommand', headBucket: 'HeadBucketCommand',
  deleteObject: 'DeleteObjectCommand', deleteObjects: 'DeleteObjectsCommand', copyObject: 'CopyObjectCommand',
  listObjectsV2: 'ListObjectsV2Command', listBuckets: 'ListBucketsCommand' });

class Lambda { constructor(options = {}) { this.client = options.client || new lambdaSdk.LambdaClient(clientOptions(options)); } }
methods(Lambda, lambdaSdk, { getFunction: 'GetFunctionCommand', getFunctionConfiguration: 'GetFunctionConfigurationCommand' });
Lambda.prototype.invoke = function (params = {}, callback) {
  return request(async (abortSignal) => {
    const result = await this.client.send(new lambdaSdk.InvokeCommand(params), { abortSignal });
    return result.Payload == null ? result : { ...result, Payload: Buffer.from(result.Payload) };
  }, callback);
};
class SES { constructor(options = {}) { this.client = options.client || new sesSdk.SESClient(clientOptions(options)); } }
methods(SES, sesSdk, { sendEmail: 'SendEmailCommand' });
class CloudWatch { constructor(options = {}) { this.client = options.client || new cloudwatchSdk.CloudWatchClient(clientOptions(options)); } }
methods(CloudWatch, cloudwatchSdk, { getMetricStatistics: 'GetMetricStatisticsCommand', getMetricData: 'GetMetricDataCommand', describeAlarms: 'DescribeAlarmsCommand', putMetricData: 'PutMetricDataCommand' });
class STS { constructor(options = {}) { this.client = options.client || new stsSdk.STSClient(clientOptions(options)); } }
methods(STS, stsSdk, { getCallerIdentity: 'GetCallerIdentityCommand' });
function SharedIniFileCredentials(options) { return fromIni(options); }
const DynamoDB = { DocumentClient };
const AWS = { config, SharedIniFileCredentials, DynamoDB, S3, Lambda, SES, CloudWatch, STS };
module.exports = {
  AWS, DynamoDB, S3, Lambda, SES, CloudWatch, STS, clientOptions,
  CONNECTION_TIMEOUT_MS, DYNAMODB_IDLE_TIMEOUT_MS,
};
