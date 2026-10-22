// Only non-sensitive JSON on stdin, only --validate-only. No real request mode exists.
import { validateOssSdkBridgeConfig } from './oss-sdk-bridge.js';
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--validate-only') throw Error();
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 8192) throw Error(); chunks.push(chunk);
  }
  const result = validateOssSdkBridgeConfig(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('OSS_SDK_BRIDGE_REJECTED\n'); process.exitCode = 1;
}
