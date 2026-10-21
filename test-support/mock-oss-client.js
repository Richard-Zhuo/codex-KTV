// In-memory OSS contract model only; no network, credentials, IAM or atomicity proof.
export function mockOss({ beforePut = async () => {}, afterPut = async () => {},
  beforeGet = async () => {}, changeGet = v => v, versionStatus, versioning = null } = {}) {
  const objects = new Map(), events = [];
  const bucket = 'synthetic-backups', prefix = 'synthetic/offsite/';
  const options = () => ({ bucket, secure: true, retryMax: 0 });
  const error = (status, code) => Object.assign(Error('SYNTHETIC_SDK_PRIVATE_DETAIL'), { status, code });
  const readClient = { options: options(), async get(name, request) {
    events.push({ method: 'GET', name, request }); await beforeGet(name);
    if (!objects.has(name)) throw error(404, 'NoSuchKey');
    const content = Buffer.from(objects.get(name));
    return changeGet({ content, res: { status: 200, headers: {
      'content-length': String(content.length), 'x-oss-object-type': 'Normal'
    } } });
  } };
  const writeClient = { options: options(), get: readClient.get,
    async getBucketVersioning(name, request) {
      events.push({ method: 'VERSIONING', name, request });
      return versioning ? versioning() : { status: 200, versionStatus };
    },
    async put(name, bytes, request) {
      events.push({ method: 'PUT', name, request }); await beforePut(name, bytes);
      if (request.headers['x-oss-forbid-overwrite'] !== 'true') throw error(400, 'MissingCondition');
      // Atomic section in this model; real OSS semantics require separate cloud acceptance.
      if (objects.has(name)) throw error(409, 'FileAlreadyExists');
      objects.set(name, Buffer.from(bytes)); await afterPut(name);
      return { name, res: { status: 200, headers: {} } };
    }
  };
  return { objects, events, bucket, prefix, readClient, writeClient };
}
