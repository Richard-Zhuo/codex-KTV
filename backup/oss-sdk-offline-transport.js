// B5-B2A has no live transport. Tests replace this MODULE with an in-memory sink.
// No configuration, environment flag or caller-supplied object can enable network access.
export const offlineOssTransport = Object.freeze({
  async request() {
    throw Object.assign(Error('OSS_NETWORK_DISABLED'), { code: 'OSS_NETWORK_DISABLED' });
  }
});
