import { HttpBoundaryError } from './transport.js';
import { createHttpAuthBoundary } from './transport.js';

export function createHttpApi(options) {
  const auth = createHttpAuthBoundary(options);
  return Object.freeze({
    async handle(req, res) {
      let path;
      try { path = new URL(req.url, options.origin).pathname; }
      catch { return false; }
      if (!path.startsWith('/api/v1/')) return false;
      const requestId = auth.newRequestId();
      try {
        if (await auth.handleAuth(req, res, path, requestId)) return true;
        throw new HttpBoundaryError('invalid_input');
      } catch (error) {
        auth.handleError(res, requestId, error);
        return true;
      }
    }
  });
}
