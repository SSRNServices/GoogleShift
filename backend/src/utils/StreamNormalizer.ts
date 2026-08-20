import { Readable, PassThrough } from 'stream';

export class UploadStreamTypeError extends Error {
  public readonly actualType: string;
  public readonly constructorName: string;

  constructor(message: string, actualType: string = 'unknown', constructorName: string = 'unknown') {
    super(message);
    this.name = 'UploadStreamTypeError';
    this.actualType = actualType;
    this.constructorName = constructorName;
  }
}

/**
 * Canonical stream/body normalizer.
 * Converts any body type produced by Google Drive downloads or in-memory operations
 * (Buffer, ArrayBuffer, Uint8Array, string, WHATWG stream, AsyncIterable)
 * into a valid Node.js Readable stream with a working .pipe() method.
 */
export function toNodeReadable(body: any): Readable {
  if (body === null || body === undefined) {
    const empty = new PassThrough();
    empty.end();
    return empty;
  }

  // 1. Existing Node.js Readable stream
  if (
    typeof body === 'object' &&
    typeof body.pipe === 'function' &&
    typeof body.on === 'function'
  ) {
    return body as Readable;
  }

  // 2. Node.js Buffer
  if (Buffer.isBuffer(body)) {
    return Readable.from(body);
  }

  // 3. ArrayBuffer or SharedArrayBuffer
  if (body instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && body instanceof SharedArrayBuffer)) {
    return Readable.from(Buffer.from(body));
  }

  // 4. TypedArrays (Uint8Array, etc.)
  if (ArrayBuffer.isView(body)) {
    return Readable.from(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }

  // 5. String
  if (typeof body === 'string') {
    return Readable.from(Buffer.from(body, 'utf-8'));
  }

  // 6. WHATWG / Web ReadableStream (e.g. body.getReader exists)
  if (typeof body === 'object' && typeof body.getReader === 'function') {
    if (typeof (Readable as any).fromWeb === 'function') {
      return (Readable as any).fromWeb(body);
    }
    // Fallback manual Web stream reader adapter
    const pass = new PassThrough();
    (async () => {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pass.write(Buffer.from(value));
        }
        pass.end();
      } catch (err) {
        pass.destroy(err as Error);
      }
    })();
    return pass;
  }

  // 7. Async Iterable
  if (typeof body === 'object' && typeof body[Symbol.asyncIterator] === 'function') {
    return Readable.from(body);
  }

  // Fallback wrapper
  try {
    return Readable.from(body);
  } catch (err: any) {
    const typeName = typeof body;
    const ctorName = body?.constructor?.name || 'unknown';
    throw new UploadStreamTypeError(
      `UPLOAD_STREAM_TYPE_ERROR: Unable to convert ${typeName} (${ctorName}) to Node.js Readable stream: ${err.message}`,
      typeName,
      ctorName
    );
  }
}

/**
 * Asserts that a body is a valid Node.js Readable stream with a callable .pipe method.
 * Throws UploadStreamTypeError if invalid.
 */
export function assertNodeReadable(stream: any, contextInfo?: string): void {
  if (!stream || typeof stream !== 'object' || typeof stream.pipe !== 'function') {
    const actualType = typeof stream;
    const constructorName = stream?.constructor?.name || 'unknown';
    const detail = contextInfo ? ` for ${contextInfo}` : '';
    throw new UploadStreamTypeError(
      `UPLOAD_STREAM_TYPE_ERROR: Expected Node.js Readable stream with .pipe()${detail}, got ${actualType} (${constructorName}).`,
      actualType,
      constructorName
    );
  }
}

/**
 * Diagnostic logger helper (safe — never logs body contents or credentials)
 */
export function logBodyDiagnostics(body: any, label: string): void {
  const actualType = typeof body;
  const ctorName = body?.constructor?.name || 'unknown';
  const hasPipe = body && typeof body.pipe === 'function';
  const hasOn = body && typeof body.on === 'function';
  const hasRead = body && typeof body.read === 'function';
  const isBuffer = Buffer.isBuffer(body);
  const isArrayBuffer = body instanceof ArrayBuffer;
  const byteLength = isBuffer ? body.length : (body?.byteLength ?? 'N/A');

  console.log(
    `[STREAM_DIAGNOSTICS] Label: ${label} | Type: ${actualType} | Ctor: ${ctorName} | ` +
    `hasPipe: ${hasPipe} | hasOn: ${hasOn} | hasRead: ${hasRead} | ` +
    `isBuffer: ${isBuffer} | isArrayBuffer: ${isArrayBuffer} | ByteLength: ${byteLength}`
  );
}
